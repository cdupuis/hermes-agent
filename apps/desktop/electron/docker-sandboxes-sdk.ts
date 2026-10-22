import type { SandboxesApi } from './docker-sandboxes-provision'

/**
 * `SandboxesApi` over the real `@docker/sandboxes` SDK, PAT-authenticated.
 * Electron-free so a script can drive the provisioning flow against Cloud; the
 * SDK is imported lazily so it costs nothing until the card is used.
 */
// File reads go through the stream client, whose StreamError carries the same
// `code`/`httpStatus` as RequestError but is not one of its subclasses (seen live).
function hasCode(error: unknown, code: string, httpStatus: number): boolean {
  const e = error as { code?: unknown; httpStatus?: unknown } | null

  return Boolean(e && (e.code === code || e.httpStatus === httpStatus))
}

export async function createSandboxesApi(
  username: string,
  personalAccessToken: string
): Promise<{ api: SandboxesApi; close: () => Promise<void> }> {
  const sdk = await import('@docker/sandboxes')
  const client = new sdk.Sandboxes({ auth: sdk.pat({ username, personalAccessToken }) })
  const get = (name: string) => client.get(name)

  const api: SandboxesApi = {
    createVolume: async (displayName, idempotencyKey) =>
      (await client.volumes.create({ displayName }, { idempotencyKey })).name,
    createSandbox: async input =>
      (
        await client.create(
          {
            displayName: input.displayName,
            environment: input.environment,
            resources: 'small',
            kits: [{ artifact: { ref: { ref: input.kitRef, kind: 'sandbox' }, inline: input.artifact } }],
            storage: {
              // Exclusive is what lets a volume-backed sandbox hibernate (seen live, 2026-10-22).
              volumes: [{ volume: input.volume, target: input.volumeTarget, mode: 'exclusive' }],
              // An empty list is refused ("repeated.min_items", seen live): omit it instead.
              ...(input.secrets.length ? { secrets: input.secrets } : {})
            },
            lifecycle: { timeoutMs: input.cycleMs, onTimeout: input.onTimeout, autoResume: input.onTimeout === 'stop' }
          } as any,
          { idempotencyKey: input.idempotencyKey, timeoutMs: input.timeoutMs } as any
        )
      ).name,
    waitRunning: async (name, timeoutMs) => {
      await (await get(name)).waitUntilRunning({ timeoutMs })
    },
    publishPort: async (name, number, idempotencyKey) => {
      const port = await (await get(name)).ports.create({ number } as any, { idempotencyKey } as any)

      return String(port.resource.url || '')
    },
    readFile: async (name, path) => {
      try {
        return await (await get(name)).files.read(path, { encoding: 'utf8' })
      } catch (error) {
        if (error instanceof sdk.NotFoundError || hasCode(error, 'notFound', 404)) {
          return null
        }

        throw error
      }
    },
    removeFile: async (name, path) => {
      await (await get(name)).files.remove(path)
    },
    sandboxStatus: async name => {
      try {
        return String((await get(name)).status || '').toLowerCase()
      } catch (error) {
        if (error instanceof sdk.NotFoundError || hasCode(error, 'notFound', 404)) {
          return null
        }

        throw error
      }
    },
    deleteSandbox: async name => {
      await (await get(name)).delete({ force: true } as any)
    },
    // Every mutation re-reads the sandbox: an older handle's etag fails after any change (seen live).
    startSandbox: async (name, timeoutMs) => {
      await (await (await get(name)).start({ timeoutMs })).waitUntilRunning({ timeoutMs })
    },
    createSecret: async (displayName, serviceType, value) =>
      (await client.secrets.create({ displayName, serviceType, token: { value } })).name,
    updateSecret: async (name, serviceType, value) => {
      await (await client.secrets.get(name)).update({ serviceType, token: { value } } as any)
    },
    deleteSecret: async name => {
      await (await client.secrets.get(name)).delete()
    },
    listSecrets: async () => {
      const found = []

      for await (const secret of client.secrets.all()) {
        found.push({
          name: secret.name,
          displayName: String(secret.displayName ?? ''),
          serviceType: String(secret.serviceType ?? '')
        })
      }

      return found
    },
    findVolume: async displayName => {
      for await (const volume of client.volumes.all()) {
        if (volume.displayName === displayName) {
          return volume.name
        }
      }

      return null
    },
    isConflict: error => error instanceof sdk.ConflictError,
    // A request Cloud turned down (bad argument, missing entitlement), as opposed to a transport or quota failure.
    isRefused: error =>
      error instanceof sdk.RequestError &&
      [400, 403, 409, 412].includes(Number((error as { httpStatus?: unknown }).httpStatus)),
    isRateLimited: error => error instanceof sdk.RateLimitError || hasCode(error, 'resourceExhausted', 429)
  }

  return { api, close: () => client.close() }
}
