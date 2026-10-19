/**
 * docker-sandboxes-keeper.ts
 *
 * Keeps Docker Cloud Sandboxes gateways usable. Cloud caps a sandbox at 24 hours
 * in total — renewals cannot extend it ("maximum of 86400 seconds per session",
 * seen live) — and, with a volume attached, deletes it at expiry. So a gateway
 * survives by being recreated, not renewed. For every gateway the card created,
 * a periodic pass:
 *
 *   - gateway entry removed           → forget the record (the user retired it);
 *   - sandbox gone, failed, or within → provision again under the same name: the
 *     RECREATE_MARGIN of its expiry      same state volume is adopted, a fresh login
 *                                        issued, the entry re-pointed and signed in;
 *   - otherwise                       → make sure the entry still has a live session,
 *                                        signing in again with the stored login.
 *
 * Secrets (the Docker PAT, the generated gateway password) are stored through
 * Desktop's secret envelope, the policy every Desktop secret follows.
 * Electron-free: the store, SDK, clock and connection plumbing are injected.
 */

import type { ProvisionResult, SandboxesApi } from './docker-sandboxes-provision'

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

export type KeeperOutcome = 'failed' | 'forgotten' | 'ok' | 'recreated' | 'signed-in' | 'skipped'

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
  now: () => number
  rememberLog: (line: string) => void
}

/** Recreate this long before Cloud's deadline, so the swap happens on our schedule. */
export const RECREATE_MARGIN_MS = 35 * 60_000

/** Statuses after which the sandbox will not serve again. */
const GONE = new Set(['deleted', 'deleting', 'failed', 'stopped'])

export function upsertRecord(records: KeeperRecord[], record: KeeperRecord): KeeperRecord[] {
  return [...records.filter(r => r.connectionId !== record.connectionId), record]
}

export function createKeeper(deps: KeeperDeps) {
  let running: Promise<Record<string, KeeperOutcome>> | null = null

  async function recreate(record: KeeperRecord, api: SandboxesApi, pat: string, exists: boolean) {
    if (exists) {
      // The old sandbox still holds the volume, and attachment is exclusive.
      await api.deleteSandbox(record.sandbox)
    }

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
    if (!deps.connectionExists(record.connectionId)) {
      deps.rememberLog(`[docker-sandboxes] ${record.label}: gateway removed; no longer managed`)

      return { outcome: 'forgotten', record: null }
    }

    const pat = deps.decrypt(record.pat)

    if (!pat) {
      return { outcome: 'skipped', record }
    }

    const { api, close } = await deps.openApi(record.username, pat)

    try {
      const status = await api.sandboxStatus(record.sandbox)
      const expiresAt = status === null ? null : await api.sandboxExpiresAt(record.sandbox)
      const expiring = expiresAt !== null && expiresAt - deps.now() < RECREATE_MARGIN_MS

      if (status === null || GONE.has(status) || expiring) {
        const why = expiring ? 'about to expire' : (status ?? 'gone')
        deps.rememberLog(`[docker-sandboxes] ${record.label}: ${record.sandbox} is ${why}; recreating`)

        return { outcome: 'recreated', record: await recreate(record, api, pat, status !== null) }
      }

      if (await deps.hasSession(record.connectionId, record.url)) {
        return { outcome: 'ok', record }
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

  return {
    /** One pass over every record; concurrent callers share the pass in flight. */
    check(): Promise<Record<string, KeeperOutcome>> {
      running ??= pass().finally(() => {
        running = null
      })

      return running
    },
    remember(record: KeeperRecord): void {
      deps.store.write(upsertRecord(deps.store.read(), record))
    }
  }
}
