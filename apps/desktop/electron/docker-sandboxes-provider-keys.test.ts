import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createProviderKeyRouter, DOCKER_SECRET_PREVIEW, PROVIDER_KEY_SERVICES } from './docker-sandboxes-provider-keys'

function harness(managed = true, services: string[] = ['anthropic']) {
  const sets: Array<[string, string, null | string]> = []
  let gatewayCalls = 0

  const router = createProviderKeyRouter({
    setProviderKey: async (id, service, value) => (sets.push([id, service, value]), managed),
    providerKeyServices: async () => (managed ? services : null),
    rememberLog: () => undefined
  })

  const gateway = async () => {
    gatewayCalls += 1

    return {
      ANTHROPIC_API_KEY: { is_set: false, redacted_value: null },
      OPENAI_API_KEY: { is_set: false, redacted_value: null },
      GITHUB_TOKEN: { is_set: true, redacted_value: 'ghp_…' }
    }
  }

  return { gateway, gatewayCalls: () => gatewayCalls, router, sets }
}

test('provider keys: a sandbox gateway stores a model key as a Docker secret, never in the sandbox', async () => {
  const h = harness()

  const routed = await h.router.route(
    { path: '/api/env', method: 'PUT', body: { key: 'ANTHROPIC_API_KEY', value: ' sk-ant-1 ', provider_setup: true } },
    'docker-sandbox',
    h.gateway
  )

  assert.deepEqual(routed, { handled: true, result: { ok: true } })
  assert.deepEqual(h.sets, [['docker-sandbox', 'anthropic', 'sk-ant-1']])
  assert.equal(h.gatewayCalls(), 0)
})

test('provider keys: deleting the key removes the Docker secret', async () => {
  const h = harness()

  await h.router.route(
    { path: '/api/env', method: 'DELETE', body: { key: 'OPENAI_API_KEY' } },
    'docker-sandbox',
    h.gateway
  )

  assert.deepEqual(h.sets, [['docker-sandbox', 'openai', null]])
})

test('provider keys: the listing shows the Docker-stored keys as set', async () => {
  const h = harness()

  const routed = await h.router.route({ path: '/api/env', method: 'GET' }, 'docker-sandbox', h.gateway)
  const rows = (routed as { result: Record<string, { is_set: boolean; redacted_value: unknown }> }).result

  assert.deepEqual(rows.ANTHROPIC_API_KEY, { is_set: true, redacted_value: DOCKER_SECRET_PREVIEW })
  assert.equal(rows.OPENAI_API_KEY.is_set, false)
  assert.deepEqual(rows.GITHUB_TOKEN, { is_set: true, redacted_value: 'ghp_…' })
})

test('provider keys: other keys, other profiles and other gateways go to the gateway as before', async () => {
  const h = harness(false)
  const passes = (routed: unknown) => assert.deepEqual(routed, { handled: false })

  // Not a key the proxy injects: the gateway's .env is the only place for it.
  passes(
    await harness().router.route(
      { path: '/api/env', method: 'PUT', body: { key: 'GITHUB_TOKEN', value: 'ghp_1' } },
      'docker-sandbox',
      h.gateway
    )
  )
  // A Docker secret serves every profile, so a profile's own key stays the profile's.
  passes(
    await harness().router.route(
      { path: '/api/env', method: 'PUT', profile: 'work', body: { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-1' } },
      'docker-sandbox',
      h.gateway
    )
  )
  // A gateway the keeper does not manage.
  passes(
    await h.router.route(
      { path: '/api/env', method: 'PUT', body: { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-1' } },
      'homelab',
      h.gateway
    )
  )
  passes(await h.router.route({ path: '/api/status', method: 'GET' }, 'docker-sandbox', h.gateway))
})

test('provider keys: the display preview can never overwrite the stored key', async () => {
  const h = harness()

  await assert.rejects(
    h.router.route(
      { path: '/api/env', method: 'PUT', body: { key: 'ANTHROPIC_API_KEY', value: DOCKER_SECRET_PREVIEW } },
      'docker-sandbox',
      h.gateway
    )
  )
  assert.deepEqual(h.sets, [])
})

test('provider keys: the routed env vars are exactly the kit credentials', () => {
  assert.deepEqual(PROVIDER_KEY_SERVICES, {
    ANTHROPIC_API_KEY: 'anthropic',
    OPENAI_API_KEY: 'openai',
    OPENROUTER_API_KEY: 'openrouter'
  })
})
