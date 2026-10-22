import type { DockerSandboxesTranslations } from './types_docker_sandboxes'

// Settings > Gateways > Docker Cloud Sandboxes card, composed by en.ts as `settings.dockerSandboxes`.
export const enDockerSandboxes: DockerSandboxesTranslations = {
  title: 'Docker Cloud Sandboxes',
  modeDesc: 'Create a gateway in a Docker Cloud Sandbox from your Docker Hub login.',
  description:
    'Run a Hermes gateway in a Docker Cloud Sandbox. Its memory, skills and sessions live on a persistent volume, and model keys stay in your Docker account.',
  usernameTitle: 'Docker Hub username',
  usernameDesc: 'The Docker account with Cloud Sandboxes access.',
  patTitle: 'Personal access token',
  patDesc: 'Stored in your keychain so Desktop can wake the sandbox and rebuild it if it is ever lost.',
  provision: 'Create gateway',
  provisioning: 'Creating…',
  steps: {
    volume: 'Creating the state volume…',
    sandbox: 'Creating the sandbox…',
    starting: 'Starting the sandbox…',
    port: 'Publishing the gateway…',
    login: 'Waiting for the first boot…',
    ready: 'Waiting for the gateway to answer…'
  },
  done: 'Your Docker Sandbox gateway is ready and signed in.',
  doneSignInNeeded: 'Your Docker Sandbox gateway is ready. Use Sign in on its row with the login below.',
  lifetimeNote:
    'The sandbox hibernates once a day and resumes on its own, with the same address, memory, skills and sessions. If it is ever lost, Desktop rebuilds it on the same volume.',
  addKey:
    'Next, add a model key in Settings → Providers. It is stored as a secret in your Docker account; the sandbox never sees it.',
  notKeptAlive: 'This gateway will not be recreated automatically: Hermes could not store your token securely.',
  failed: step => `Could not create the gateway (${step}).`,
  unavailable: 'This build of Hermes Desktop cannot create cloud sandboxes.'
}
