import type { DesktopDockerSandboxesStep } from '@/global'

// Settings > Gateways > Docker Cloud Sandboxes card; `Translations.settings.dockerSandboxes`.
export interface DockerSandboxesTranslations {
  title: string
  modeDesc: string
  description: string
  usernameTitle: string
  usernameDesc: string
  patTitle: string
  patDesc: string
  provision: string
  provisioning: string
  steps: Record<DesktopDockerSandboxesStep, string>
  done: string
  doneSignInNeeded: string
  lifetimeNote: string
  notKeptAlive: string
  failed: (step: string) => string
  unavailable: string
}
