/**
 * docker-sandboxes-provider-keys.ts
 *
 * Settings → Providers (and onboarding) save a model key with `PUT /api/env`,
 * which writes it into the gateway's own `.env`. For a Docker Sandboxes gateway
 * that would put the real key inside the sandbox, where anything the agent runs
 * can read it. So for the providers the kit's proxy injects, the save becomes a
 * Cloud secret in the user's Docker account instead (the keeper attaches it),
 * and the sandbox only ever sees the proxy's placeholder.
 *
 * The gateway reports a key as set only when its `.env` holds it, so the
 * listing (`GET /api/env`) is overlaid with the secrets Desktop stored.
 * Profile-scoped requests pass through: a Cloud secret serves every profile of
 * the gateway, so it may only answer for the default one.
 *
 * Electron-free; docker-sandboxes-ipc.ts wires the keeper in.
 */

import { HERMES_SERVE_KIT } from './docker-sandboxes-kit'

/** Env var → kit credential service, for the API keys the kit's proxy injects. */
export const PROVIDER_KEY_SERVICES: Readonly<Record<string, string>> = Object.fromEntries(
  HERMES_SERVE_KIT.credentials.map(credential => [credential.apiKey.name, credential.service])
)

/** What the Providers screen shows for a key that lives in the Docker account. */
export const DOCKER_SECRET_PREVIEW = 'Docker secret'

const SERVICES_CACHE_MS = 30_000

export interface ProviderKeyRouterDeps {
  /** Resolves to false for a connection the keeper does not manage. */
  setProviderKey: (connectionId: string, service: string, value: null | string) => Promise<boolean>
  /** Services with a stored key, or null for a connection the keeper does not manage. */
  providerKeyServices: (connectionId: string) => Promise<null | string[]>
  rememberLog: (line: string) => void
  now?: () => number
}

export interface ApiRequest {
  path?: unknown
  method?: unknown
  body?: unknown
  profile?: unknown
}

export type RoutedRequest = { handled: false } | { handled: true; result: unknown }

function envRoute(request: ApiRequest): null | { method: string; key: string; value: unknown } {
  const path = String(request?.path ?? '').split('?')[0]
  const profile = String(request?.profile ?? '').trim()

  if (path !== '/api/env' || (profile && profile !== 'default')) {
    return null
  }

  const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
  const bodyProfile = String(body.profile ?? '').trim()

  if (bodyProfile && bodyProfile !== 'default') {
    return null
  }

  return { method: String(request.method ?? 'GET').toUpperCase(), key: String(body.key ?? ''), value: body.value }
}

export function createProviderKeyRouter(deps: ProviderKeyRouterDeps) {
  const now = deps.now ?? Date.now
  const cache = new Map<string, { at: number; services: null | string[] }>()

  async function storedServices(connectionId: string): Promise<null | string[]> {
    const hit = cache.get(connectionId)

    if (hit && now() - hit.at < SERVICES_CACHE_MS) {
      return hit.services
    }

    const services = await deps.providerKeyServices(connectionId)
    cache.set(connectionId, { at: now(), services })

    return services
  }

  async function overlay(connectionId: string, listing: unknown): Promise<unknown> {
    if (!listing || typeof listing !== 'object') {
      return listing
    }

    let services: null | string[]

    try {
      services = await storedServices(connectionId)
    } catch (error) {
      // The listing still answers; it just cannot show the Docker-stored keys this time.
      deps.rememberLog(
        `[docker-sandboxes] could not list provider keys: ${error instanceof Error ? error.message : String(error)}`
      )

      return listing
    }

    if (!services?.length) {
      return listing
    }

    const rows = { ...(listing as Record<string, Record<string, unknown>>) }

    for (const [envVar, service] of Object.entries(PROVIDER_KEY_SERVICES)) {
      if (services.includes(service) && rows[envVar]) {
        rows[envVar] = { ...rows[envVar], is_set: true, redacted_value: DOCKER_SECRET_PREVIEW }
      }
    }

    return rows
  }

  return {
    /**
     * Handle `/api/env` for a keeper-managed gateway; anything else, or a gateway
     * the keeper does not manage, is left to `passThrough`.
     */
    async route(request: ApiRequest, connectionId: null | string, passThrough: () => Promise<unknown>) {
      const route = connectionId ? envRoute(request) : null

      if (!route || !connectionId) {
        return { handled: false } satisfies RoutedRequest
      }

      if (route.method === 'GET') {
        return { handled: true, result: await overlay(connectionId, await passThrough()) } satisfies RoutedRequest
      }

      const service = PROVIDER_KEY_SERVICES[route.key]

      if (!service || (route.method !== 'PUT' && route.method !== 'DELETE')) {
        return { handled: false } satisfies RoutedRequest
      }

      const value = route.method === 'PUT' ? String(route.value ?? '').trim() : null

      if (value === DOCKER_SECRET_PREVIEW || value === '') {
        // The display preview (or nothing) must never overwrite the stored key.
        throw new Error('Enter the key itself; the stored one cannot be shown.')
      }

      cache.delete(connectionId)

      if (!(await deps.setProviderKey(connectionId, service, value))) {
        return { handled: false } satisfies RoutedRequest
      }

      cache.delete(connectionId)

      return { handled: true, result: { ok: true } } satisfies RoutedRequest
    }
  }
}
