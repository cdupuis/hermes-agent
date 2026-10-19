import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createKeeper, type KeeperDeps, type KeeperRecord, RECREATE_MARGIN_MS } from './docker-sandboxes-keeper'
import type { ProvisionResult, SandboxesApi } from './docker-sandboxes-provision'

const NOW = 1_800_000_000_000

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
  credentials: ['anthropic']
}

function harness(
  { status = 'running', expiresAt = NOW + 12 * 3_600_000, session = true } = {} as {
    status?: null | string
    expiresAt?: null | number
    session?: boolean
  },
  overrides: Partial<KeeperDeps> = {}
) {
  const calls: Array<[string, ...unknown[]]> = []
  let records = [RECORD]

  const api = {
    sandboxStatus: async (name: string) => (calls.push(['sandboxStatus', name]), status),
    sandboxExpiresAt: async () => expiresAt,
    deleteSandbox: async (name: string) => void calls.push(['deleteSandbox', name])
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
    now: () => NOW,
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

test('keeper: a sandbox about to expire is replaced early, deleting the old one first', async () => {
  const h = harness({ expiresAt: NOW + RECREATE_MARGIN_MS - 60_000 })

  assert.deepEqual(await createKeeper(h.deps).check(), { 'docker-sandbox': 'recreated' })
  // The old sandbox still holds the volume (attachment is exclusive).
  assert.ok(h.names().indexOf('deleteSandbox') < h.names().indexOf('provision'))
})

test('keeper: a sandbox with plenty of time left is not replaced', async () => {
  const h = harness({ expiresAt: NOW + RECREATE_MARGIN_MS + 60_000 })

  await createKeeper(h.deps).check()
  assert.ok(!h.names().includes('provision'))
})

test('keeper: a failed sandbox is deleted, then recreated', async () => {
  const h = harness({ status: 'failed' })
  await createKeeper(h.deps).check()

  assert.ok(h.names().indexOf('deleteSandbox') < h.names().indexOf('provision'))
})

test('keeper: a gateway the user removed is forgotten, not recreated', async () => {
  const h = harness({ status: null }, { connectionExists: () => false })

  assert.deepEqual(await createKeeper(h.deps).check(), { 'docker-sandbox': 'forgotten' })
  assert.deepEqual(h.records(), [])
  assert.ok(!h.names().includes('openApi'))
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
