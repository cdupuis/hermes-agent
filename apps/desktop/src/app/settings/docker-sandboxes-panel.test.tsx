import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'

import { DockerSandboxesPanel } from './docker-sandboxes-panel'

const { refreshConnectionsRegistry, selectConnection } = vi.hoisted(() => ({
  refreshConnectionsRegistry: vi.fn(),
  selectConnection: vi.fn()
}))

vi.mock('@/store/connections', () => ({ refreshConnectionsRegistry, selectConnection }))

const d = en.settings.dockerSandboxes
const provision = vi.fn()
let progress: ((step: string) => void) | null = null

beforeEach(() => {
  refreshConnectionsRegistry.mockResolvedValue(null)
  selectConnection.mockResolvedValue(undefined)
  ;(window as any).hermesDesktop = {
    ...(window as any).hermesDesktop,
    dockerSandboxes: {
      provision,
      onProgress: (callback: (step: string) => void) => {
        progress = callback

        return () => {
          progress = null
        }
      }
    }
  }
})

afterEach(() => {
  cleanup()
  provision.mockReset()
  selectConnection.mockReset()
  delete (window as any).hermesDesktop.dockerSandboxes
})

function fill(label: string, value: string) {
  const row = screen.getByText(label).closest('div[class]')!.parentElement!.parentElement!

  fireEvent.change(row.querySelector('input')!, { target: { value } })
}

function fillForm() {
  fill(d.usernameTitle, 'alice')
  fill(d.patTitle, 'dckr_pat_secret')
}

describe('Docker Cloud Sandboxes panel', () => {
  it('says so when the build has no provisioning bridge', () => {
    delete (window as any).hermesDesktop.dockerSandboxes
    render(<DockerSandboxesPanel />)
    expect(screen.getByText(d.unavailable)).toBeTruthy()
  })

  it('asks for the Docker Hub username and PAT only, and needs both', () => {
    const { container } = render(<DockerSandboxesPanel />)

    expect(container.querySelectorAll('input')).toHaveLength(2)
    const button = screen.getByRole('button', { name: d.provision })
    expect(button).toHaveProperty('disabled', true)
    fill(d.usernameTitle, 'alice')
    expect(button).toHaveProperty('disabled', true)
    fill(d.patTitle, 'dckr_pat_secret')
    expect(button).toHaveProperty('disabled', false)
  })

  it('provisions with defaults, switches to the new gateway, and keeps no credential in the page', async () => {
    let finish!: (value: unknown) => void
    provision.mockReturnValue(new Promise(resolve => (finish = resolve)))
    const { container } = render(<DockerSandboxesPanel />)
    fillForm()
    fireEvent.click(screen.getByRole('button', { name: d.provision }))

    // Only the credentials cross the bridge; name, image, size and lifetime are the provisioner's defaults.
    expect(provision).toHaveBeenCalledWith({ username: 'alice', personalAccessToken: 'dckr_pat_secret' })
    act(() => progress?.('port'))
    expect(screen.getByText(d.steps.port)).toBeTruthy()

    await act(async () =>
      finish({
        ok: true,
        connectionId: 'docker-sandbox',
        url: 'https://9119-x.example',
        signedIn: true,
        autoRecreate: true
      })
    )

    await waitFor(() => expect(selectConnection).toHaveBeenCalledWith('docker-sandbox'))
    expect(refreshConnectionsRegistry).toHaveBeenCalled()
    expect(screen.queryByText(d.notKeptAlive)).toBeNull()
    expect(screen.queryByText(d.addKey)).toBeNull()
    expect(container.innerHTML).not.toContain('dckr_pat_secret')
  })

  it('says so when the gateway cannot be kept alive', async () => {
    provision.mockResolvedValue({ ok: true, connectionId: 'docker-sandbox', signedIn: true, autoRecreate: false })
    render(<DockerSandboxesPanel />)
    fillForm()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: d.provision })))
    expect(screen.getByText(d.notKeptAlive)).toBeTruthy()
  })

  it('points to Settings → Providers when the gateway has no model key yet', async () => {
    provision.mockResolvedValue({ ok: true, connectionId: 'docker-sandbox', signedIn: true, needsKey: true })
    render(<DockerSandboxesPanel />)
    fillForm()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: d.provision })))
    expect(screen.getByText(d.addKey)).toBeTruthy()
  })

  it('reports a failed provision and stays put', async () => {
    provision.mockResolvedValue({ ok: false, step: 'sandbox', error: 'quota exceeded' })
    render(<DockerSandboxesPanel />)
    fillForm()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: d.provision })))
    expect(selectConnection).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: d.provision })).toHaveProperty('disabled', false)
  })
})
