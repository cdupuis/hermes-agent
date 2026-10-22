/**
 * docker-sandboxes-keeper.ts
 *
 * Keeps Docker Cloud Sandboxes gateways usable. A sandbox hibernates in place at
 * the end of each cycle (docker-sandboxes-provision.ts), so most passes find it
 * running or asleep; only a sandbox that is really gone is rebuilt. For every
 * gateway the card created, a periodic pass:
 *
 *   - gateway entry removed  → delete its sandbox (it no longer expires on its own)
 *                              and forget the record; the volume and keys stay;
 *   - sandbox hibernated     → resume it (same URL, processes and memory intact);
 *   - sandbox gone or failed → provision again under the same name: the same state
 *                              volume is adopted, a fresh login issued, the entry
 *                              re-pointed and signed in;
 *   - otherwise              → make sure the entry still has a live session,
 *                              signing in again with the stored login.
 *
 * It also owns the gateway's model keys (setProviderKey): they are Cloud
 * secrets Desktop stores in the Docker account, attached at create. A changed
 * key is updated in place; a key added or removed needs the sandbox rebuilt,
 * since Cloud attaches secrets only when it creates one.
 *
 * Secrets (the Docker PAT, the generated gateway password) are stored through
 * Desktop's secret envelope, the policy every Desktop secret follows.
 * Electron-free: the store, SDK, clock and connection plumbing are injected.
 */

import { ownedSecretName, type ProvisionResult, type SandboxesApi } from './docker-sandboxes-provision'

export interface KeeperRecord {
  connectionId: string
  label: string
  username: string
  /** Desktop secret envelope of the Docker PAT. */
  pat: unknown
  sandbox: string
  volume: string
  url: string
  gatewayUsername: string
  /** Desktop secret envelope of the generated gateway password. */
  gatewayPassword: unknown
}

export interface KeeperStore {
  read(): KeeperRecord[]
  write(records: KeeperRecord[]): void
}

export type KeeperOutcome = 'failed' | 'forgotten' | 'ok' | 'recreated' | 'resumed' | 'signed-in' | 'skipped'

export interface KeeperDeps {
  store: KeeperStore
  encrypt: (value: string) => unknown
  decrypt: (secret: unknown) => string
  openApi: (username: string, personalAccessToken: string) => Promise<{ api: SandboxesApi; close: () => Promise<void> }>
  provision: (
    input: { name: string; username: string; personalAccessToken: string },
    api: SandboxesApi
  ) => Promise<ProvisionResult>
  connectionExists: (connectionId: string) => boolean
  /** Point the gateway entry at the recreated sandbox and sign it in; resolves to signed-in. */
  repoint: (connectionId: string, label: string, result: ProvisionResult) => Promise<boolean>
  hasSession: (connectionId: string, url: string) => Promise<boolean>
  signIn: (connectionId: string, url: string, username: string, password: string) => Promise<boolean>
  rememberLog: (line: string) => void
}

/** Statuses after which the sandbox will not serve again. */
const GONE = new Set(['deleted', 'deleting', 'failed'])
const RESUME_TIMEOUT_MS = 300_000

export function upsertRecord(records: KeeperRecord[], record: KeeperRecord): KeeperRecord[] {
  return [...records.filter(r => r.connectionId !== record.connectionId), record]
}

export function createKeeper(deps: KeeperDeps) {
  let running: Promise<Record<string, KeeperOutcome>> | null = null
  // Passes and key changes rebuild sandboxes; one at a time, or two would race for the volume.
  let queue: Promise<unknown> = Promise.resolve()

  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)

    return next
  }

  async function recreate(
    record: KeeperRecord,
    api: SandboxesApi,
    pat: string,
    exists: boolean,
    beforeProvision?: () => Promise<void>
  ) {
    if (exists) {
      // The old sandbox still holds the volume, and attachment is exclusive.
      await api.deleteSandbox(record.sandbox)
    }

    await beforeProvision?.()

    const result = await deps.provision(
      { name: record.label, username: record.username, personalAccessToken: pat },
      api
    )

    const signedIn = await deps.repoint(record.connectionId, record.label, result)
    deps.rememberLog(
      `[docker-sandboxes] ${record.label}: recreated as ${result.sandbox} on ${result.volume} (signed in: ${signedIn})`
    )

    return {
      ...record,
      sandbox: result.sandbox,
      volume: result.volume,
      url: result.url,
      gatewayUsername: result.username,
      gatewayPassword: deps.encrypt(result.password)
    }
  }

  async function checkOne(record: KeeperRecord): Promise<{ outcome: KeeperOutcome; record: KeeperRecord | null }> {
    const pat = deps.decrypt(record.pat)

    if (!pat) {
      // Without the token nothing can be done in Cloud; keep the record while the gateway exists.
      return deps.connectionExists(record.connectionId)
        ? { outcome: 'skipped', record }
        : { outcome: 'forgotten', record: null }
    }

    const { api, close } = await deps.openApi(record.username, pat)

    try {
      if (!deps.connectionExists(record.connectionId)) {
        // The user retired the gateway. Its sandbox would otherwise run (and bill) forever.
        if ((await api.sandboxStatus(record.sandbox)) !== null) {
          await api.deleteSandbox(record.sandbox)
        }

        deps.rememberLog(`[docker-sandboxes] ${record.label}: gateway removed; deleted ${record.sandbox}`)

        return { outcome: 'forgotten', record: null }
      }

      const status = await api.sandboxStatus(record.sandbox)

      if (status === null || GONE.has(status)) {
        deps.rememberLog(`[docker-sandboxes] ${record.label}: ${record.sandbox} is ${status ?? 'gone'}; recreating`)

        return { outcome: 'recreated', record: await recreate(record, api, pat, status !== null) }
      }

      let resumed = false

      if (status === 'stopped') {
        await api.startSandbox(record.sandbox, RESUME_TIMEOUT_MS)
        deps.rememberLog(`[docker-sandboxes] ${record.label}: resumed ${record.sandbox}`)
        resumed = true
      }

      if (await deps.hasSession(record.connectionId, record.url)) {
        return { outcome: resumed ? 'resumed' : 'ok', record }
      }

      const password = deps.decrypt(record.gatewayPassword)

      const signedIn =
        Boolean(password) && (await deps.signIn(record.connectionId, record.url, record.gatewayUsername, password))

      deps.rememberLog(`[docker-sandboxes] ${record.label}: session lapsed; signed in again: ${signedIn}`)

      return { outcome: signedIn ? 'signed-in' : 'failed', record }
    } finally {
      await close().catch(() => undefined)
    }
  }

  async function pass(): Promise<Record<string, KeeperOutcome>> {
    const outcomes: Record<string, KeeperOutcome> = {}
    let records = deps.store.read()

    for (const record of [...records]) {
      try {
        const { outcome, record: next } = await checkOne(record)
        outcomes[record.connectionId] = outcome
        records = next ? upsertRecord(records, next) : records.filter(r => r.connectionId !== record.connectionId)
      } catch (error) {
        // Transient Cloud trouble must not drop the record; the next pass retries.
        outcomes[record.connectionId] = 'failed'
        deps.rememberLog(
          `[docker-sandboxes] ${record.label}: keep-alive failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    deps.store.write(records)

    return outcomes
  }

  /**
   * Store, change or (value null) remove the gateway's key for one provider service. Resolves to
   * false for a connection this keeper does not manage, so the caller can fall through.
   */
  async function setProviderKey(connectionId: string, service: string, value: null | string): Promise<boolean> {
    const record = deps.store.read().find(r => r.connectionId === connectionId)

    if (!record) {
      return false
    }

    await exclusive(async () => {
      const pat = deps.decrypt(record.pat)

      if (!pat) {
        throw new Error('The Docker token for this gateway is no longer readable; create the gateway again.')
      }

      const { api, close } = await deps.openApi(record.username, pat)

      try {
        const displayName = ownedSecretName(service)
        const owned = (await api.listSecrets()).find(secret => secret.displayName === displayName)

        if (value !== null && owned) {
          await api.updateSecret(owned.name, service, value)
          deps.rememberLog(`[docker-sandboxes] ${record.label}: updated the ${service} key`)

          return
        }

        if (value === null && !owned) {
          return
        }

        // Cloud attaches secrets only at create: rebuild the sandbox on the same volume.
        const exists = (await api.sandboxStatus(record.sandbox)) !== null

        const change = async () => {
          if (value === null) {
            await api.deleteSecret(owned!.name)
          }
        }

        if (value !== null) {
          await api.createSecret(displayName, service, value)
        }

        const next = await recreate(record, api, pat, exists, change)
        deps.store.write(upsertRecord(deps.store.read(), next))
        deps.rememberLog(
          `[docker-sandboxes] ${record.label}: ${value === null ? 'removed' : 'added'} the ${service} key`
        )
      } finally {
        await close().catch(() => undefined)
      }
    })

    return true
  }

  return {
    /** One pass over every record; concurrent callers share the pass in flight. */
    check(): Promise<Record<string, KeeperOutcome>> {
      running ??= exclusive(pass).finally(() => {
        running = null
      })

      return running
    },
    setProviderKey,
    /** The provider services whose key Desktop stored for this gateway, or null if it is not managed. */
    async providerKeyServices(connectionId: string): Promise<null | string[]> {
      const record = deps.store.read().find(r => r.connectionId === connectionId)
      const pat = record ? deps.decrypt(record.pat) : ''

      if (!record || !pat) {
        return null
      }

      const { api, close } = await deps.openApi(record.username, pat)

      try {
        return (await api.listSecrets())
          .filter(secret => secret.displayName === ownedSecretName(secret.serviceType))
          .map(secret => secret.serviceType)
      } finally {
        await close().catch(() => undefined)
      }
    },
    remember(record: KeeperRecord): void {
      deps.store.write(upsertRecord(deps.store.read(), record))
    }
  }
}
