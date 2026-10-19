import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { DesktopDockerSandboxesProvisionResult, DesktopDockerSandboxesStep } from '@/global'
import { useI18n } from '@/i18n'
import { Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { refreshConnectionsRegistry, selectConnection } from '@/store/connections'
import { notify, notifyError } from '@/store/notifications'

import { ListRow } from './primitives'

const CONTROL = 'h-8 text-[length:var(--conversation-text-font-size)]'

/**
 * Settings > Gateways > Docker Cloud Sandboxes: the panel behind the connection
 * card of the same name. Only the Docker Hub username and a PAT are asked for;
 * the gateway name, image, size and lifetime are the provisioner's defaults
 * (electron/docker-sandboxes-provision.ts). Electron provisions, saves an
 * ordinary signed-in Remote gateway, and the window switches to it, like the
 * Hermes Cloud picker. The generated gateway password never reaches the
 * renderer; Electron keeps the PAT (encrypted) to renew and recreate the
 * sandbox (electron/docker-sandboxes-keeper.ts).
 */
export function DockerSandboxesPanel() {
  const { t } = useI18n()
  const d = t.settings.dockerSandboxes
  const api = window.hermesDesktop?.dockerSandboxes
  const [username, setUsername] = useState('')
  const [pat, setPat] = useState('')
  const [step, setStep] = useState<DesktopDockerSandboxesStep | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DesktopDockerSandboxesProvisionResult | null>(null)

  useEffect(() => api?.onProgress(next => setStep(next)), [api])

  if (!api) {
    return (
      <p className="mt-5 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {d.unavailable}
      </p>
    )
  }

  const canSubmit = !busy && Boolean(username.trim() && pat.trim())

  const provision = async () => {
    setBusy(true)
    setResult(null)
    setStep('volume')

    try {
      const response = await api.provision({ username: username.trim(), personalAccessToken: pat.trim() })

      if (!response.ok) {
        notifyError(new Error(response.error || ''), d.failed(response.step ? d.steps[response.step] : ''))

        return
      }

      setResult(response)
      // The PAT is not needed past this call; drop it from memory.
      setPat('')
      await refreshConnectionsRegistry()

      if (response.connectionId) {
        await selectConnection(response.connectionId)
      }

      notify({ kind: 'success', message: response.signedIn ? d.done : d.doneSignInNeeded })
    } catch (error) {
      notifyError(error, d.failed(step ? d.steps[step] : ''))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  return (
    <div className="mt-5 grid gap-1">
      <p className="mb-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {d.description}
      </p>
      <ListRow
        action={
          <Input
            autoComplete="username"
            className={CONTROL}
            disabled={busy}
            onChange={event => setUsername(event.target.value)}
            value={username}
          />
        }
        description={d.usernameDesc}
        title={d.usernameTitle}
      />
      <ListRow
        action={
          <Input
            autoComplete="off"
            className={cn(CONTROL, 'font-mono')}
            disabled={busy}
            onChange={event => setPat(event.target.value)}
            type="password"
            value={pat}
          />
        }
        description={d.patDesc}
        title={d.patTitle}
      />

      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        {busy && step ? (
          <span className="mr-auto text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
            {d.steps[step]}
          </span>
        ) : null}
        <Button disabled={!canSubmit} onClick={() => void provision()} size="sm">
          {busy ? <Loader2 className="animate-spin" /> : null}
          {busy ? d.provisioning : d.provision}
        </Button>
      </div>

      {result?.ok && result.autoRecreate === false ? (
        <p className="mt-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)">
          {d.notKeptAlive}
        </p>
      ) : null}

      <p className="mt-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {d.lifetimeNote}
      </p>
    </div>
  )
}
