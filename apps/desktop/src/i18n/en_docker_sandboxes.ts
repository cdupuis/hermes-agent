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
  patDesc: 'Stored in your keychain so Desktop can recreate the sandbox before it expires.',
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
    'Cloud sandboxes last at most 24 hours. Desktop recreates this one on the same volume before it expires, so the gateway keeps its memory, skills and sessions.',
  notKeptAlive: 'This gateway will not be recreated automatically: Hermes could not store your token securely.',
  failed: step => `Could not create the gateway (${step}).`,
  unavailable: 'This build of Hermes Desktop cannot create cloud sandboxes.'
}
