import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { test } from 'vitest'

import { HERMES_SERVE_KIT } from './docker-sandboxes-kit'
import {
  attachableSecrets,
  BACKEND_PORT,
  CYCLE_MS,
  DEFAULT_GATEWAY_NAME,
  DEFAULT_HERMES_SERVE_IMAGE,
  HERMES_HOME_TARGET,
  KIT_CREDENTIAL_SERVICES,
  kitArtifact,
  LOGIN_FILE,
  LOGIN_NONCE_ENV,
  ownedSecretName,
  parseLogin,
  ProvisionError,
  provisionHermesSandbox,
  sandboxDisplayName,
  type SandboxesApi,
  validateProvisionInput
} from './docker-sandboxes-provision'

class RateLimited extends Error {}

class Conflict extends Error {}

class Refused extends Error {}

function fakeApi(overrides: Partial<SandboxesApi> = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  let reads = 0

  const api: SandboxesApi = {
    createVolume: async (...args) => (calls.push(['createVolume', ...args]), 'volumes/v1'),
    createSandbox: async input => (calls.push(['createSandbox', input]), 'sandboxes/s1'),
    waitRunning: async (...args) => void calls.push(['waitRunning', ...args]),
    publishPort: async (...args) => (calls.push(['publishPort', ...args]), 'https://9119-s1.example/'),
    readFile: async (...args) => {
      calls.push(['readFile', ...args])
      reads += 1

      return reads < 3 ? null : '{"username":"hermes","password":"pw-1"}'
    },
    removeFile: async (...args) => void calls.push(['removeFile', ...args]),
    deleteSandbox: async (...args) => void calls.push(['deleteSandbox', ...args]),
    startSandbox: async (...args) => void calls.push(['startSandbox', ...args]),
    sandboxStatus: async () => 'running',
    findVolume: async (...args) => (calls.push(['findVolume', ...args]), null),
    listSecrets: async () => [
      { name: 'secrets/docker', displayName: 'docker', serviceType: 'docker' },
      { name: 'secrets/anthropic', displayName: ownedSecretName('anthropic'), serviceType: 'anthropic' },
      { name: 'secrets/openai', displayName: ownedSecretName('openai'), serviceType: 'openai' }
    ],
    createSecret: async (...args) => (calls.push(['createSecret', ...args]), 'secrets/new'),
    updateSecret: async (...args) => void calls.push(['updateSecret', ...args]),
    deleteSecret: async (...args) => void calls.push(['deleteSecret', ...args]),
    isConflict: error => error instanceof Conflict,
    isRateLimited: error => error instanceof RateLimited,
    isRefused: error => error instanceof Refused,
    ...overrides
  }

  return { api, calls }
}

const input = { name: 'My Cloud', username: 'alice', personalAccessToken: 'dckr_pat_x' }
const quick = { sleep: async () => undefined, randomId: () => 'run1' }

test('provision: creates the volume, the sandbox on it, publishes 9119 and returns the one-shot login', async () => {
  const { api, calls } = fakeApi()
  const steps: string[] = []

  const result = await provisionHermesSandbox(input, {
    api,
    httpStatus: async () => 200,
    onStep: s => steps.push(s),
    ...quick
  })

  assert.deepEqual(result, {
    url: 'https://9119-s1.example',
    username: 'hermes',
    password: 'pw-1',
    sandbox: 'sandboxes/s1',
    volume: 'volumes/v1',
    credentials: ['anthropic', 'openai'],
    onTimeout: 'restart'
  })
  assert.deepEqual(steps, ['volume', 'sandbox', 'starting', 'port', 'login', 'ready'])
  assert.deepEqual(calls[0], ['createVolume', 'My-Cloud-hermes-home', 'hermes-desktop:run1:volume'])
  const create = calls[1][1] as Parameters<SandboxesApi['createSandbox']>[0]
  assert.equal(create.displayName, 'My-Cloud')
  assert.equal(create.volume, 'volumes/v1')
  assert.equal(create.volumeTarget, HERMES_HOME_TARGET)
  // The kit's declared providers only, and attached: without that the proxy injects nothing.
  assert.deepEqual(create.secrets, ['secrets/anthropic', 'secrets/openai'])
  // Hibernate and resume in place at the end of each (longest allowed) cycle.
  assert.equal(create.cycleMs, CYCLE_MS)
  assert.equal(create.onTimeout, 'restart')
  assert.deepEqual(create.environment, { [LOGIN_NONCE_ENV]: 'run1' })
  assert.equal(create.kitRef, 'hermes-serve')
  assert.equal(JSON.parse(new TextDecoder().decode(create.artifact)).manifest.template, DEFAULT_HERMES_SERVE_IMAGE)
  assert.deepEqual(
    calls.find(c => c[0] === 'publishPort'),
    ['publishPort', 'sandboxes/s1', BACKEND_PORT, 'hermes-desktop:run1:port']
  )
  assert.deepEqual(
    calls.find(c => c[0] === 'removeFile'),
    ['removeFile', 'sandboxes/s1', LOGIN_FILE]
  )
  assert.ok(!calls.some(c => c[0] === 'deleteSandbox'))
})

test('provision: endpoint rate limits right after start are retried, not fatal', async () => {
  let failures = 2

  const { api } = fakeApi({
    readFile: async () => {
      if (failures-- > 0) {
        throw new RateLimited('resourceExhausted')
      }

      return '{"username":"hermes","password":"pw-2"}'
    }
  })

  const result = await provisionHermesSandbox(input, { api, httpStatus: async () => 200, ...quick })
  assert.equal(result.password, 'pw-2')
})

test('provision: a failure after create deletes the sandbox and keeps the volume', async () => {
  const { api, calls } = fakeApi({ publishPort: async () => Promise.reject(new Error('quota')) })
  const failure = await provisionHermesSandbox(input, { api, httpStatus: async () => 200, ...quick }).catch(e => e)

  assert.match(failure.message, /quota/)
  assert.equal(failure.step, 'port')
  assert.ok(calls.some(c => c[0] === 'deleteSandbox' && c[1] === 'sandboxes/s1'))
})

test('provision: a backend that never writes its login times out at the login step', async () => {
  let clock = 0
  const { api } = fakeApi({ readFile: async () => null })

  const failure = await provisionHermesSandbox(input, {
    api,
    httpStatus: async () => 200,
    ...quick,
    now: () => (clock += 10_000)
  }).catch(error => error)

  assert.ok(failure instanceof ProvisionError)
  assert.equal(failure.step, 'login')
})

test('provision: waits until the public URL answers', async () => {
  const statuses = [502, 0, 200]
  const seen: string[] = []
  const { api } = fakeApi()
  await provisionHermesSandbox(input, {
    api,
    httpStatus: async url => (seen.push(url), statuses.shift() ?? 200),
    ...quick
  })
  assert.deepEqual(seen, Array(3).fill('https://9119-s1.example/api/status'))
})

test('validateProvisionInput: trims, requires name/username/PAT, keeps an image override', () => {
  assert.deepEqual(validateProvisionInput({ ...input, name: '  x ', image: ' img:1 ' }), {
    ...input,
    name: 'x',
    image: 'img:1'
  })
  assert.throws(() => validateProvisionInput({ ...input, personalAccessToken: ' ' }), /personal access token/)
  // No name: the fixed default, so a re-create lands on the same volume and gateway entry.
  assert.equal(validateProvisionInput({ ...input, name: '' }).name, DEFAULT_GATEWAY_NAME)
  assert.equal(validateProvisionInput({ username: 'u', personalAccessToken: 'p' }).name, 'Docker Sandbox')
})

test('sandboxDisplayName: maps a label onto the API display-name alphabet', () => {
  assert.equal(sandboxDisplayName('My Cloud / dev'), 'My-Cloud-dev')
  assert.equal(sandboxDisplayName('***'), 'hermes')
  assert.match(sandboxDisplayName('x'.repeat(200)), /^x{48}$/)
})

test('parseLogin: only a complete login counts', () => {
  assert.deepEqual(parseLogin('{"username":"u","password":"p"}'), { username: 'u', password: 'p' })
  assert.equal(parseLogin('{"username":"u"'), null)
  assert.equal(parseLogin('{"username":"u","password":""}'), null)
})

test('kitArtifact: the packed kit with only the image swapped', () => {
  const artifact = JSON.parse(new TextDecoder().decode(kitArtifact('example.test/img:2')))
  assert.equal(artifact.manifest.template, 'example.test/img:2')
  assert.deepEqual(
    { ...artifact, manifest: { ...artifact.manifest, template: undefined } },
    {
      ...HERMES_SERVE_KIT,
      manifest: { ...HERMES_SERVE_KIT.manifest, template: undefined }
    }
  )
})

test('the embedded kit is the Go-reference golden of docker-sandboxes/kit', () => {
  const golden = JSON.parse(
    readFileSync(
      path.resolve(__dirname, '../../../docker-sandboxes/provisioner/tests/golden/hermes-serve.json'),
      'utf8'
    )
  )

  assert.deepEqual(HERMES_SERVE_KIT, golden)
})

test('provision: a name whose volume already exists adopts it (how a deleted gateway comes back)', async () => {
  const { api, calls } = fakeApi({
    createVolume: async () => Promise.reject(new Conflict('alreadyExists')),
    findVolume: async name => (name === 'My-Cloud-hermes-home' ? 'volumes/kept' : null)
  })

  const result = await provisionHermesSandbox(input, { api, httpStatus: async () => 200, ...quick })

  assert.equal(result.volume, 'volumes/kept')
  assert.equal((calls.find(c => c[0] === 'createSandbox')![1] as { volume: string }).volume, 'volumes/kept')
})

test('provision: other volume failures are not mistaken for an existing volume', async () => {
  const { api } = fakeApi({ createVolume: async () => Promise.reject(new Error('quota')) })

  await assert.rejects(provisionHermesSandbox(input, { api, httpStatus: async () => 200, ...quick }), /quota/)
})

test('provision: a gateway without any stored key is still created; the key comes later', async () => {
  const { api, calls } = fakeApi({
    listSecrets: async () => [{ name: 'secrets/docker', displayName: 'docker', serviceType: 'docker' }]
  })

  const result = await provisionHermesSandbox(input, { api, httpStatus: async () => 200, ...quick })

  assert.deepEqual(result.credentials, [])
  assert.deepEqual((calls.find(c => c[0] === 'createSandbox')![1] as { secrets: string[] }).secrets, [])
})

test('provision: an account without the restart entitlement gets a sandbox that sleeps and wakes on demand', async () => {
  const actions: string[] = []

  const { api } = fakeApi({
    createSandbox: async request => {
      actions.push(request.onTimeout)

      if (request.onTimeout === 'restart') {
        throw new Refused('needs AlwaysOn and Hibernate')
      }

      return 'sandboxes/s1'
    }
  })

  const result = await provisionHermesSandbox(input, { api, httpStatus: async () => 200, ...quick })

  assert.deepEqual(actions, ['restart', 'stop'])
  assert.equal(result.onTimeout, 'stop')
})

test('provision: a refusal that is not about the timeout action reports the original reason', async () => {
  const { api } = fakeApi({
    createSandbox: async request => Promise.reject(new Refused(`bad request (${request.onTimeout})`))
  })

  await assert.rejects(
    provisionHermesSandbox(input, { api, httpStatus: async () => 200, ...quick }),
    /bad request \(restart\)/
  )
})

test('provision: a create failure that is not a refusal is not retried as stop', async () => {
  let creates = 0
  const { api } = fakeApi({ createSandbox: async () => (creates++, Promise.reject(new Error('network down'))) })

  await assert.rejects(provisionHermesSandbox(input, { api, httpStatus: async () => 200, ...quick }), /network down/)
  assert.equal(creates, 1)
})

test('attachableSecrets: only the secrets Desktop stored, one per declared service', () => {
  assert.deepEqual(
    attachableSecrets([
      // Stored by `sbx`: Cloud refuses to attach these ("immutable resource identity").
      { name: 'sbx', displayName: 'docker-sbx:anthropic', serviceType: 'anthropic' },
      { name: 'a1', displayName: ownedSecretName('anthropic'), serviceType: 'anthropic' },
      { name: 'a2', displayName: ownedSecretName('anthropic'), serviceType: 'anthropic' },
      { name: 'g', displayName: ownedSecretName('github'), serviceType: 'github' },
      { name: 'r', displayName: ownedSecretName('openrouter'), serviceType: 'openrouter' }
    ]).map(s => s.name),
    ['a1', 'r']
  )
  assert.deepEqual([...KIT_CREDENTIAL_SERVICES].sort(), ['anthropic', 'openai', 'openrouter'])
})
