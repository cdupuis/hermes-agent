import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createKeeper, type KeeperDeps, type KeeperRecord } from './docker-sandboxes-keeper'
import {
  ownedSecretName,
  type ProvisionResult,
  type SandboxesApi,
  type StoredSecret
} from './docker-sandboxes-provision'

const RECORD: KeeperRecord = {
  connectionId: 'docker-sandbox',
  label: 'Docker Sandbox',
  username: 'alice',
  pat: { encoding: 'plain', value: 'dckr_pat_x' },
  sandbox: 'sandboxes/old',
  volume: 'volumes/v1',
  url: 'https://9119-old.example',
  gatewayUsername: 'hermes',
  gatewayPassword: { encoding: 'plain', value: 'old-pw' }
}

const RECREATED: ProvisionResult = {
  url: 'https://9119-new.example',
  username: 'hermes',
  password: 'new-pw',
  sandbox: 'sandboxes/new',
  volume: 'volumes/v1',
  credentials: ['anthropic'],
  onTimeout: 'restart'
}

function harness(
  { status = 'running', session = true, secrets = [] } = {} as {
    status?: null | string
    session?: boolean
    secrets?: StoredSecret[]
  },
  overrides: Partial<KeeperDeps> = {}
) {
  const calls: Array<[string, ...unknown[]]> = []
  let records = [RECORD]

  const api = {
    sandboxStatus: async (name: string) => (calls.push(['sandboxStatus', name]), status),
    deleteSandbox: async (name: string) => void calls.push(['deleteSandbox', name]),
    startSandbox: async (name: string) => void calls.push(['startSandbox', name]),
    listSecrets: async () => secrets,
    createSecret: async (...args: unknown[]) => (calls.push(['createSecret', ...args]), 'secrets/new'),
    updateSecret: async (...args: unknown[]) => void calls.push(['updateSecret', ...args]),
    deleteSecret: async (...args: unknown[]) => void calls.push(['deleteSecret', ...args])
  } as unknown as SandboxesApi

  const deps: KeeperDeps = {
    store: { read: () => records, write: next => void (records = next) },
    encrypt: value => ({ encoding: 'plain', value }),
    decrypt: secret => (secret as { value: string }).value,
    openApi: async (username, pat) => (calls.push(['openApi', username, pat]), { api, close: async () => undefined }),
    provision: async (input, _api) => (calls.push(['provision', input]), RECREATED),
    connectionExists: () => true,
    repoint: async (id, label, result) => (calls.push(['repoint', id, label, result.url]), true),
    hasSession: async () => session,
    signIn: async (...args) => (calls.push(['signIn', ...args]), true),
    rememberLog: () => undefined,
    ...overrides
  }

  return { calls, deps, names: () => calls.map(c => c[0]), records: () => records }
}

test('keeper: a healthy gateway with a live session is left alone', async () => {
  const h = harness()

  assert.deepEqual(await createKeeper(h.deps).check(), { 'docker-sandbox': 'ok' })
  assert.ok(!h.names().includes('provision') && !h.names().includes('signIn'))
})

test('keeper: a lapsed session is signed in again with the stored gateway login', async () => {
  const h = harness({ session: false })

  assert.deepEqual(await createKeeper(h.deps).check(), { 'docker-sandbox': 'signed-in' })
  assert.deepEqual(
    h.calls.find(c => c[0] === 'signIn'),
    ['signIn', 'docker-sandbox', 'https://9119-old.example', 'hermes', 'old-pw']
  )
})

test('keeper: an expired sandbox is recreated under the same name and the gateway re-pointed', async () => {
  const h = harness({ status: null })

  assert.deepEqual(await createKeeper(h.deps).check(), { 'docker-sandbox': 'recreated' })
  // Same name -> same state volume (the provisioner adopts it).
  assert.deepEqual(h.calls.find(c => c[0] === 'provision')![1], {
    name: 'Docker Sandbox',
    username: 'alice',
    personalAccessToken: 'dckr_pat_x'
  })
  assert.deepEqual(
    h.calls.find(c => c[0] === 'repoint'),
    ['repoint', 'docker-sandbox', 'Docker Sandbox', 'https://9119-new.example']
  )
  const [record] = h.records()
  assert.equal(record.sandbox, 'sandboxes/new')
  assert.equal(record.url, 'https://9119-new.example')
  // The fresh login replaces the old one, so a later lapse can still sign in.
  assert.deepEqual(record.gatewayPassword, { encoding: 'plain', value: 'new-pw' })
  assert.ok(!h.names().includes('deleteSandbox'))
})

test('keeper: a hibernated sandbox is resumed in place, never replaced', async () => {
  const h = harness({ status: 'stopped' })

  assert.deepEqual(await createKeeper(h.deps).check(), { 'docker-sandbox': 'resumed' })
  assert.deepEqual(
    h.calls.find(c => c[0] === 'startSandbox'),
    ['startSandbox', 'sandboxes/old']
  )
  // Same sandbox, same URL: nothing to re-point, and the memory snapshot keeps its processes.
  assert.ok(!h.names().includes('provision') && !h.names().includes('deleteSandbox'))
  assert.deepEqual(h.records(), [RECORD])
})

test('keeper: a failed sandbox is deleted, then recreated', async () => {
  const h = harness({ status: 'failed' })
  await createKeeper(h.deps).check()

  assert.ok(h.names().indexOf('deleteSandbox') < h.names().indexOf('provision'))
})

test('keeper: a gateway the user removed is forgotten and its sandbox deleted, not recreated', async () => {
  const h = harness({}, { connectionExists: () => false })

  assert.deepEqual(await createKeeper(h.deps).check(), { 'docker-sandbox': 'forgotten' })
  assert.deepEqual(h.records(), [])
  // A hibernating sandbox never expires: left alone it would run and bill forever.
  assert.deepEqual(
    h.calls.find(c => c[0] === 'deleteSandbox'),
    ['deleteSandbox', 'sandboxes/old']
  )
  assert.ok(!h.names().includes('provision'))
})

test('keeper: a Cloud failure keeps the record for the next pass', async () => {
  const h = harness({ status: null }, { provision: async () => Promise.reject(new Error('quota')) })

  assert.deepEqual(await createKeeper(h.deps).check(), { 'docker-sandbox': 'failed' })
  assert.deepEqual(h.records(), [RECORD])
})

test('keeper: concurrent checks share one pass', async () => {
  const h = harness({ session: false })
  const keeper = createKeeper(h.deps)
  const [a, b] = await Promise.all([keeper.check(), keeper.check()])

  assert.equal(a, b)
  assert.equal(h.calls.filter(c => c[0] === 'signIn').length, 1)
})

test('keeper: remember replaces the record for the same gateway', () => {
  const h = harness()
  createKeeper(h.deps).remember({ ...RECORD, sandbox: 'sandboxes/fresh' })

  assert.deepEqual(
    h.records().map(r => r.sandbox),
    ['sandboxes/fresh']
  )
})

const ANTHROPIC = { name: 'secrets/a', displayName: ownedSecretName('anthropic'), serviceType: 'anthropic' }

test('provider keys: a gateway this keeper does not manage falls through', async () => {
  const h = harness()

  assert.equal(await createKeeper(h.deps).setProviderKey('other', 'anthropic', 'sk-ant-1'), false)
  assert.ok(!h.names().includes('openApi'))
})

test('provider keys: changing a stored key updates the secret in place, without a rebuild', async () => {
  const h = harness({ secrets: [ANTHROPIC] })

  assert.equal(await createKeeper(h.deps).setProviderKey('docker-sandbox', 'anthropic', 'sk-ant-2'), true)
  assert.deepEqual(
    h.calls.find(c => c[0] === 'updateSecret'),
    ['updateSecret', 'secrets/a', 'anthropic', 'sk-ant-2']
  )
  assert.ok(!h.names().includes('provision') && !h.names().includes('deleteSandbox'))
})

test('provider keys: a first key is stored, then the sandbox is rebuilt so Cloud attaches it', async () => {
  // A secret `sbx` stored under another name is not Desktop's: Cloud would refuse to attach it.
  const h = harness({
    secrets: [{ name: 'secrets/sbx', displayName: 'docker-sbx:anthropic', serviceType: 'anthropic' }]
  })

  await createKeeper(h.deps).setProviderKey('docker-sandbox', 'anthropic', 'sk-ant-1')

  assert.deepEqual(
    h.calls.find(c => c[0] === 'createSecret'),
    ['createSecret', ownedSecretName('anthropic'), 'anthropic', 'sk-ant-1']
  )
  const order = h.names()
  assert.ok(order.indexOf('createSecret') < order.indexOf('deleteSandbox'))
  assert.ok(order.indexOf('deleteSandbox') < order.indexOf('provision'))
  assert.equal(h.records()[0].url, 'https://9119-new.example')
})

test('provider keys: removing a key detaches it by rebuilding, then deletes the secret', async () => {
  const h = harness({ secrets: [ANTHROPIC] })

  await createKeeper(h.deps).setProviderKey('docker-sandbox', 'anthropic', null)

  const order = h.names()
  // The running sandbox holds the secret until it is gone.
  assert.ok(order.indexOf('deleteSandbox') < order.indexOf('deleteSecret'))
  assert.ok(order.indexOf('deleteSecret') < order.indexOf('provision'))
})

test('provider keys: the stored services are the ones Desktop owns', async () => {
  const h = harness({
    secrets: [ANTHROPIC, { name: 'secrets/sbx', displayName: 'docker-sbx:openai', serviceType: 'openai' }]
  })

  const keeper = createKeeper(h.deps)

  assert.deepEqual(await keeper.providerKeyServices('docker-sandbox'), ['anthropic'])
  assert.equal(await keeper.providerKeyServices('other'), null)
})

test('keeper: an unreadable Docker token keeps the record while the gateway exists', async () => {
  const h = harness({}, { decrypt: () => '' })

  assert.deepEqual(await createKeeper(h.deps).check(), { 'docker-sandbox': 'skipped' })
  assert.deepEqual(h.records(), [RECORD])
})
