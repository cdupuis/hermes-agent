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
              volumes: [{ volume: input.volume, target: input.volumeTarget }],
              secrets: input.secrets
            },
            lifecycle: { timeoutMs: input.lifetimeMs, onTimeout: 'delete' }
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
    sandboxExpiresAt: async name => {
      const expiresAt = (await get(name)).effectiveFeatures?.timeouts?.expiresAt
      const ms = expiresAt ? new Date(expiresAt as unknown as string).getTime() : NaN

      return Number.isFinite(ms) ? ms : null
    },
    deleteSandbox: async name => {
      await (await get(name)).delete({ force: true } as any)
    },
    listSecrets: async () => {
      const found = []

      for await (const secret of client.secrets.all()) {
        found.push({ name: secret.name, serviceType: String(secret.serviceType ?? '') })
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
    isRateLimited: error => error instanceof sdk.RateLimitError || hasCode(error, 'resourceExhausted', 429)
  }

  return { api, close: () => client.close() }
}
