import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'

import { GatewaySettings } from './gateway-settings'

// The Docker Cloud Sandboxes card sits in the connection-mode row but is a creation
// flow, not a mode: it may never be what Save persists.

const { registry, activeId } = vi.hoisted(() => ({ registry: { value: null as any }, activeId: { value: 'local' } }))

vi.mock('@nanostores/react', () => ({ useStore: (store: any) => store.value }))
vi.mock('@/store/connections', () => ({
  $connectionsRegistry: registry,
  $activeConnectionId: activeId,
  refreshConnectionsRegistry: vi.fn().mockResolvedValue(null),
  selectConnection: vi.fn().mockResolvedValue(undefined),
  setConnectionsRegistry: vi.fn()
}))
vi.mock('./connections-registry', async importOriginal => ({
  ...(await importOriginal<any>()),
  ConnectionsRegistrySection: () => null
}))
vi.mock('./managed-updates-section', () => ({ ManagedUpdatesSection: () => null }))

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const g = en.settings.gateway
const d = en.settings.dockerSandboxes

const localConnection = {
  cloudOrg: '',
  envOverride: false,
  mode: 'local',
  remoteAuthMode: 'token',
  remoteOauthConnected: false,
  remoteTokenPreview: null,
  remoteTokenSet: false,
  remoteUrl: ''
}

const saveConnectionConfig = vi.fn()

beforeEach(() => {
  saveConnectionConfig.mockResolvedValue(localConnection)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      cloud: {
        discover: vi.fn().mockResolvedValue({ agents: [], org: null }),
        status: vi.fn().mockResolvedValue({ signedIn: false })
      },
      dockerSandboxes: { provision: vi.fn(), onProgress: () => () => undefined },
      getConnectionConfig: vi.fn().mockResolvedValue(localConnection),
      saveConnectionConfig
    }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const modeTitles = () =>
  screen
    .getAllByRole('button')
    .map(button => button.textContent ?? '')
    .filter(text =>
      [g.localTitle, g.cloudTitle, d.title, g.remoteTitle, g.sshTitle].some(title => text.startsWith(title))
    )

describe('Gateway settings: Docker Cloud Sandboxes card', () => {
  it('sits between Hermes Cloud and Remote gateway', async () => {
    render(<GatewaySettings />)
    await screen.findByRole('button', { name: g.saveAndReconnect })

    expect(
      modeTitles().map(text =>
        [g.localTitle, g.cloudTitle, d.title, g.remoteTitle, g.sshTitle].find(t => text.startsWith(t))
      )
    ).toEqual([g.localTitle, g.cloudTitle, d.title, g.remoteTitle, g.sshTitle])
  })

  it('swaps in the username + PAT panel and hides Save, then gives the page back', async () => {
    render(<GatewaySettings />)
    await screen.findByRole('button', { name: g.saveAndReconnect })

    fireEvent.click(screen.getByText(d.title))
    expect(screen.getByText(d.usernameTitle)).toBeTruthy()
    expect(screen.getByText(d.patTitle)).toBeTruthy()
    expect(screen.queryByRole('button', { name: g.saveAndReconnect })).toBeNull()

    fireEvent.click(screen.getByText(g.localTitle))
    expect(screen.queryByText(d.usernameTitle)).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: g.saveForRestart }))
    expect(saveConnectionConfig).toHaveBeenCalledWith(expect.objectContaining({ mode: 'local' }))
  })
})
