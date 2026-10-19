/**
 * docker-sandboxes-provision.ts
 *
 * Provision a Hermes backend (`hermes serve`) in a Docker Cloud Sandbox for the
 * Gateways page's "Docker Cloud Sandboxes" card. Electron-free: the SDK sits
 * behind `SandboxesApi` so the flow tests without a Docker account, and
 * docker-sandboxes-ipc.ts wires the real `@docker/sandboxes` client in.
 *
 * Flow (the same one docker-sandboxes/provisioner implements in Python):
 *   volume → sandbox from the inline `hermes-serve` kit, the volume at HERMES_HOME
 *   → wait running → publish port 9119 → read + delete the one-shot dashboard
 *   login the kit's bootstrap writes → wait for /api/status on the public URL.
 *
 * Cloud facts this encodes (seen live, 2026-10):
 *   - Declaring a credential in the kit is not enough: the account's stored
 *     secret must be ATTACHED at create (`storage.secrets`). Only then does
 *     the proxy swap the in-container sentinel for the key on egress, and
 *     Cloud set SBX_CRED_<SERVICE>_MODE, which the kit's credential script
 *     reads to keep the sentinel. Unattached, every model call 401s.
 *   - Lifetime is capped at 24h per sandbox, renewals included ("maximum of
 *     86400 seconds per session"), and with a volume attached `delete` is the only
 *     expiry action accepted (no hibernate, no restart). State lives on the
 *     volume, so an expired sandbox is recreated on it without loss.
 *   - The managed volume mounts root-owned; the kit re-owns it.
 *   - Volume display names are unique per account; an existing one is reused.
 *   - Sandbox-endpoint calls (files) answer resourceExhausted for a few seconds
 *     after start while the scoped credential is minted, so they retry.
 */

import { HERMES_SERVE_KIT } from './docker-sandboxes-kit'

// The kit's own digest-pinned image (docker-sandboxes/kit/spec.yaml).
export const DEFAULT_HERMES_SERVE_IMAGE: string = HERMES_SERVE_KIT.manifest.template
export const BACKEND_PORT = 9119
export const HERMES_HOME_TARGET = '/home/agent/.hermes'
export const LOGIN_FILE = `${HERMES_HOME_TARGET}/.sbx/desktop-login.json`
// Read by the kit's hermes-serve-bootstrap.sh; not a secret.
export const LOGIN_NONCE_ENV = 'HSBX_LOGIN_NONCE'
export const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000
// The first create from a new image waits on a ~1.5 GB pull; 180s timed out live.
const CREATE_TIMEOUT_MS = 600_000
const RUNNING_TIMEOUT_MS = 300_000
const LOGIN_TIMEOUT_MS = 180_000
const READY_TIMEOUT_MS = 180_000
const POLL_MS = 2_000

/**
 * The default gateway name. Fixed on purpose: it names the state volume, so
 * creating the gateway again after its sandbox expired finds the same volume
 * (memory, skills, sessions) and the same gateway entry.
 */
export const DEFAULT_GATEWAY_NAME = 'Docker Sandbox'

export interface ProvisionInput {
  /** Display name for the sandbox and the gateway entry. */
  name: string
  username: string
  personalAccessToken: string
  /** Kit image override; the packed kit's image otherwise. */
  image?: string
}

export interface ProvisionResult {
  url: string
  username: string
  password: string
  sandbox: string
  volume: string
  /** Service types of the stored secrets attached (e.g. `anthropic`). */
  credentials: string[]
}

export interface StoredSecret {
  name: string
  serviceType: string
}

export type ProvisionStep = 'volume' | 'sandbox' | 'starting' | 'port' | 'login' | 'ready'

/** The slice of `@docker/sandboxes` the flow uses; see docker-sandboxes-ipc.ts. */
export interface SandboxesApi {
  createVolume(displayName: string, idempotencyKey: string): Promise<string>
  createSandbox(input: {
    displayName: string
    artifact: Uint8Array
    kitRef: string
    volume: string
    volumeTarget: string
    /** Stored-secret resource names to attach (`storage.secrets`). */
    secrets: string[]
    /** Non-secret sandbox environment (the kit's login nonce). */
    environment: Record<string, string>
    lifetimeMs: number
    idempotencyKey: string
    timeoutMs: number
  }): Promise<string>
  waitRunning(sandbox: string, timeoutMs: number): Promise<void>
  publishPort(sandbox: string, port: number, idempotencyKey: string): Promise<string>
  /** null when the file does not exist yet. */
  readFile(sandbox: string, path: string): Promise<null | string>
  removeFile(sandbox: string, path: string): Promise<void>
  deleteSandbox(sandbox: string): Promise<void>
  /** The sandbox's status (`running`, `deleting`, …), or null when it no longer exists. */
  sandboxStatus(sandbox: string): Promise<null | string>
  /** When Cloud will delete the sandbox (ms since epoch), or null when unknown. */
  sandboxExpiresAt(sandbox: string): Promise<null | number>
  listSecrets(): Promise<StoredSecret[]>
  /** The volume carrying this display name, or null. */
  findVolume(displayName: string): Promise<null | string>
  isConflict(error: unknown): boolean
  isRateLimited(error: unknown): boolean
}

export interface ProvisionDeps {
  api: SandboxesApi
  /** GET a public URL; resolves to the HTTP status, rejects on transport failure. */
  httpStatus: (url: string) => Promise<number>
  onStep?: (step: ProvisionStep) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  randomId?: () => string
}

export class ProvisionError extends Error {
  constructor(
    readonly step: ProvisionStep,
    message: string,
    readonly sandbox = ''
  ) {
    super(message)
    this.name = 'ProvisionError'
  }
}

/** The model-provider services the kit declares credentials for. */
export const KIT_CREDENTIAL_SERVICES: readonly string[] = HERMES_SERVE_KIT.credentials.map(c => c.service)

/** The account's stored secrets the kit can use, one per service (first wins). */
export function attachableSecrets(secrets: StoredSecret[]): StoredSecret[] {
  const picked = new Map<string, StoredSecret>()

  for (const secret of secrets) {
    if (KIT_CREDENTIAL_SERVICES.includes(secret.serviceType) && !picked.has(secret.serviceType)) {
      picked.set(secret.serviceType, secret)
    }
  }

  return [...picked.values()]
}

const SANDBOX_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

/** The display-name rule CreateSandboxRequest enforces, applied before any create. */
export function sandboxDisplayName(label: string): string {
  const slug = label
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  return slug || 'hermes'
}

export function validateProvisionInput(input: Partial<ProvisionInput>): ProvisionInput {
  const name = String(input.name ?? '').trim() || DEFAULT_GATEWAY_NAME
  const username = String(input.username ?? '').trim()
  const personalAccessToken = String(input.personalAccessToken ?? '').trim()
  const image = String(input.image ?? '').trim()

  if (!name) {
    throw new Error('A gateway name is required.')
  }

  if (!username || !personalAccessToken) {
    throw new Error('A Docker username and personal access token are required.')
  }

  if (!SANDBOX_NAME_RE.test(sandboxDisplayName(name))) {
    throw new Error('The gateway name cannot be turned into a sandbox name.')
  }

  return { name, username, personalAccessToken, ...(image ? { image } : {}) }
}

/** The packed kit with the image swapped in, as the bytes `inline` carries. */
export function kitArtifact(image = DEFAULT_HERMES_SERVE_IMAGE): Uint8Array {
  const artifact = { ...HERMES_SERVE_KIT, manifest: { ...HERMES_SERVE_KIT.manifest, template: image } }

  return new TextEncoder().encode(JSON.stringify(artifact))
}

export function parseLogin(raw: string): { username: string; password: string } | null {
  try {
    const value = JSON.parse(raw)

    if (
      typeof value?.username === 'string' &&
      value.username &&
      typeof value?.password === 'string' &&
      value.password
    ) {
      return { username: value.username, password: value.password }
    }
  } catch {
    // Partially written or not JSON yet: the caller keeps polling.
  }

  return null
}

async function withRateLimitRetry<T>(api: SandboxesApi, sleep: (ms: number) => Promise<void>, call: () => Promise<T>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call()
    } catch (error) {
      if (attempt >= 5 || !api.isRateLimited(error)) {
        throw error
      }

      await sleep(3_000 * attempt)
    }
  }
}

export async function provisionHermesSandbox(input: ProvisionInput, deps: ProvisionDeps): Promise<ProvisionResult> {
  const { api } = deps
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const run = (deps.randomId ?? (() => Math.random().toString(36).slice(2, 10)))()
  const displayName = sandboxDisplayName(input.name)
  let current: ProvisionStep = 'volume'

  const step = (s: ProvisionStep) => {
    current = s
    deps.onStep?.(s)
  }

  // Before anything is created: a gateway without a model credential is useless.
  const secrets = attachableSecrets(await api.listSecrets())

  if (secrets.length === 0) {
    throw new ProvisionError(
      'volume',
      `This Docker account has no stored ${KIT_CREDENTIAL_SERVICES.join(', ')} secret for the gateway to use. ` +
        'Store a model provider key in the account first.'
    )
  }

  step('volume')
  const volume = await stateVolume(api, `${displayName}-hermes-home`, `hermes-desktop:${run}:volume`)

  step('sandbox')

  const sandbox = await api.createSandbox({
    displayName,
    artifact: kitArtifact(input.image),
    kitRef: HERMES_SERVE_KIT.manifest.name,
    volume,
    volumeTarget: HERMES_HOME_TARGET,
    secrets: secrets.map(secret => secret.name),
    // A fresh nonce makes the kit issue a new one-shot login even on an adopted
    // volume whose backend was set up by an earlier sandbox.
    environment: { [LOGIN_NONCE_ENV]: run },
    lifetimeMs: MAX_LIFETIME_MS,
    idempotencyKey: `hermes-desktop:${run}:sandbox`,
    timeoutMs: CREATE_TIMEOUT_MS
  })

  try {
    step('starting')
    await api.waitRunning(sandbox, RUNNING_TIMEOUT_MS)

    step('port')
    const url = (await api.publishPort(sandbox, BACKEND_PORT, `hermes-desktop:${run}:port`)).replace(/\/+$/, '')

    step('login')
    const login = await readLogin(api, sandbox, { sleep, now })
    await withRateLimitRetry(api, sleep, () => api.removeFile(sandbox, LOGIN_FILE))

    step('ready')
    await waitReady(url, deps.httpStatus, { sleep, now })

    return { url, ...login, sandbox, volume, credentials: secrets.map(secret => secret.serviceType) }
  } catch (error) {
    // A half-provisioned sandbox is useless and bills; the volume stays for a retry.
    await api.deleteSandbox(sandbox).catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)

    throw error instanceof ProvisionError ? error : new ProvisionError(current, message, sandbox)
  }
}

/**
 * Volume display names are unique per account, so a name that already has one
 * adopts it: that is how a gateway comes back after its sandbox expired, with
 * its memory, skills and sessions intact.
 */
async function stateVolume(api: SandboxesApi, displayName: string, idempotencyKey: string): Promise<string> {
  try {
    return await api.createVolume(displayName, idempotencyKey)
  } catch (error) {
    const existing = api.isConflict(error) ? await api.findVolume(displayName) : null

    if (!existing) {
      throw error
    }

    return existing
  }
}

async function readLogin(
  api: SandboxesApi,
  sandbox: string,
  { sleep, now }: { sleep: (ms: number) => Promise<void>; now: () => number }
) {
  const deadline = now() + LOGIN_TIMEOUT_MS

  while (true) {
    let raw: null | string = null

    try {
      raw = await api.readFile(sandbox, LOGIN_FILE)
    } catch (error) {
      if (!api.isRateLimited(error)) {
        throw error
      }
    }

    const login = raw ? parseLogin(raw) : null

    if (login) {
      return login
    }

    if (now() >= deadline) {
      throw new ProvisionError(
        'login',
        'The backend did not finish its first boot in time (no login was generated).',
        sandbox
      )
    }

    await sleep(POLL_MS)
  }
}

async function waitReady(
  url: string,
  httpStatus: ProvisionDeps['httpStatus'],
  { sleep, now }: { sleep: (ms: number) => Promise<void>; now: () => number }
) {
  const deadline = now() + READY_TIMEOUT_MS

  while (true) {
    const status = await httpStatus(`${url}/api/status`).catch(() => 0)

    if (status === 200) {
      return
    }

    if (now() >= deadline) {
      throw new ProvisionError('ready', `The backend at ${url} did not become reachable (last status ${status}).`)
    }

    await sleep(POLL_MS)
  }
}
