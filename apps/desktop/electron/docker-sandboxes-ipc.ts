import fs from 'node:fs'
import path from 'node:path'

import { app, ipcMain, type Session, type WebContents } from 'electron'

import { createKeeper, type KeeperRecord, type KeeperStore } from './docker-sandboxes-keeper'
import {
  type ProvisionDeps,
  ProvisionError,
  provisionHermesSandbox,
  type ProvisionResult,
  type ProvisionStep,
  validateProvisionInput
} from './docker-sandboxes-provision'
import { createSandboxesApi } from './docker-sandboxes-sdk'

/**
 * `hermes:dockerSandboxes:provision` (preload `dockerSandboxes.provision`), and
 * the keeper that holds the gateways it creates alive.
 *
 * Provisions a backend in a Docker Cloud Sandbox, then registers it as an
 * ordinary cookie-auth Remote gateway and signs it in: the generated password
 * login is POSTed through that connection's own cookie partition, the jar its
 * sockets read, so the gateway is usable without a login window. The password
 * never leaves the main process. The Docker PAT and that password are kept,
 * through Desktop's secret envelope, only so the keeper can recreate the
 * sandbox before it expires and sign the gateway in again when its session
 * lapses (docker-sandboxes-keeper.ts); when the envelope refuses
 * (keychain unavailable and no plain-text opt-in) nothing is stored and the
 * gateway simply is not kept alive.
 */

const KEEPER_INTERVAL_MS = 30 * 60_000

export interface DockerSandboxesIpcDeps {
  saveConnection: (input: {
    id?: string
    kind: 'remote'
    label: string
    url: string
    authMode: 'oauth'
  }) => Promise<{ id: string }>
  /** The id of the remote gateway entry carrying this label, if any. */
  findRemoteByLabel: (label: string) => string | undefined
  connectionExists: (connectionId: string) => boolean
  sessionForConnection: (url: string, connectionId: string) => Session | null
  hasSessionCookie: (url: string, connectionId: string) => Promise<boolean>
  /** Desktop's secret envelope; throws when it may not store the value. */
  encryptSecret: (value: string) => unknown
  decryptSecret: (secret: unknown) => string
  userDataDir: string
  rememberLog: (line: string) => void
}

export interface DockerSandboxesProvisionResponse {
  ok: boolean
  connectionId?: string
  url?: string
  signedIn?: boolean
  /** Whether Desktop will renew the sandbox and recreate it after expiry. */
  autoRecreate?: boolean
  step?: ProvisionStep
  error?: string
}

async function httpStatus(url: string): Promise<number> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })

  return response.status
}

/** POST the generated login through the connection's partition so its cookies land there. */
async function signIn(
  deps: DockerSandboxesIpcDeps,
  connectionId: string,
  url: string,
  username: string,
  password: string
): Promise<boolean> {
  const sess = deps.sessionForConnection(url, connectionId)

  if (!sess) {
    deps.rememberLog(`[docker-sandboxes] no cookie partition for ${connectionId}`)

    return false
  }

  const response = await sess.fetch(`${url}/auth/password-login`, {
    bypassCustomProtocolHandlers: true,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'basic', username, password }),
    credentials: 'include'
  })

  if (!response.ok) {
    deps.rememberLog(`[docker-sandboxes] password login answered ${response.status}`)

    return false
  }

  const cookie = await deps.hasSessionCookie(url, connectionId)

  if (!cookie) {
    deps.rememberLog(`[docker-sandboxes] password login answered ${response.status} but no session cookie landed`)
  }

  return cookie
}

/** Save (or re-point) the gateway entry for a provisioned sandbox and sign it in. */
async function registerGateway(deps: DockerSandboxesIpcDeps, label: string, result: ProvisionResult, id?: string) {
  // A recreated gateway (new sandbox, new URL, same volume) updates its entry.
  const existing = id ?? deps.findRemoteByLabel(label)

  const saved = await deps.saveConnection({
    ...(existing ? { id: existing } : {}),
    kind: 'remote',
    label,
    url: result.url,
    authMode: 'oauth'
  })

  const signedIn = await signIn(deps, saved.id, result.url, result.username, result.password).catch(error => {
    deps.rememberLog(`[docker-sandboxes] sign-in failed: ${error instanceof Error ? error.message : String(error)}`)

    return false
  })

  return { id: saved.id, signedIn }
}

function fileStore(file: string): KeeperStore {
  return {
    read: () => {
      try {
        const records = JSON.parse(fs.readFileSync(file, 'utf8'))

        return Array.isArray(records) ? records : []
      } catch {
        return []
      }
    },
    write: (records: KeeperRecord[]) => {
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, file)
    }
  }
}

export function registerDockerSandboxesIpc(deps: DockerSandboxesIpcDeps): void {
  const store = fileStore(path.join(deps.userDataDir, 'docker-sandboxes.json'))

  const keeper = createKeeper({
    store,
    encrypt: deps.encryptSecret,
    decrypt: deps.decryptSecret,
    openApi: createSandboxesApi,
    provision: (input, api) => provisionHermesSandbox(input, { api, httpStatus }),
    connectionExists: deps.connectionExists,
    repoint: async (connectionId, label, result) => (await registerGateway(deps, label, result, connectionId)).signedIn,
    hasSession: (connectionId, url) => deps.hasSessionCookie(url, connectionId),
    signIn: (connectionId, url, username, password) =>
      signIn(deps, connectionId, url, username, password).catch(() => false),
    now: Date.now,
    rememberLog: deps.rememberLog
  })

  const runKeeper = () => void keeper.check().catch(() => undefined)
  // At launch, not later: an expired sandbox's dead URL is what Desktop dials until the pass
  // re-points it, and signing in needs the cookie partitions, which exist once the app is ready.
  void app.whenReady().then(runKeeper)
  setInterval(runKeeper, KEEPER_INTERVAL_MS).unref?.()

  ipcMain.handle(
    'hermes:dockerSandboxes:provision',
    async (event, payload): Promise<DockerSandboxesProvisionResponse> => {
      let step: ProvisionStep = 'volume'
      const sender: WebContents = event.sender

      try {
        const input = validateProvisionInput(payload ?? {})
        const { api, close } = await createSandboxesApi(input.username, input.personalAccessToken)

        try {
          const onStep: ProvisionDeps['onStep'] = next => {
            step = next

            if (!sender.isDestroyed()) {
              sender.send('hermes:dockerSandboxes:progress', next)
            }
          }

          const result = await provisionHermesSandbox(input, { api, httpStatus, onStep })
          deps.rememberLog(`[docker-sandboxes] provisioned ${result.sandbox} on ${result.volume} at ${result.url}`)
          const gateway = await registerGateway(deps, input.name, result)
          const autoRecreate = rememberForKeeper(deps, keeper, input, gateway.id, result)

          return { ok: true, connectionId: gateway.id, url: result.url, signedIn: gateway.signedIn, autoRecreate }
        } finally {
          await close().catch(() => undefined)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        deps.rememberLog(`[docker-sandboxes] provisioning failed at ${step}: ${message}`)

        return { ok: false, step: error instanceof ProvisionError ? error.step : step, error: message }
      }
    }
  )
}

function rememberForKeeper(
  deps: DockerSandboxesIpcDeps,
  keeper: ReturnType<typeof createKeeper>,
  input: { name: string; username: string; personalAccessToken: string },
  connectionId: string,
  result: ProvisionResult
): boolean {
  let pat: unknown
  let gatewayPassword: unknown

  try {
    pat = deps.encryptSecret(input.personalAccessToken)
    gatewayPassword = deps.encryptSecret(result.password)
  } catch (error) {
    deps.rememberLog(
      `[docker-sandboxes] ${input.name}: not kept alive, the PAT cannot be stored: ${error instanceof Error ? error.message : String(error)}`
    )

    return false
  }

  if (!pat || !gatewayPassword) {
    return false
  }

  keeper.remember({
    connectionId,
    label: input.name,
    username: input.username,
    pat,
    sandbox: result.sandbox,
    volume: result.volume,
    url: result.url,
    gatewayUsername: result.username,
    gatewayPassword
  })

  return true
}
