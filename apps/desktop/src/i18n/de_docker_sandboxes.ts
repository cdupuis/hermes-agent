import type { DockerSandboxesTranslations } from './types_docker_sandboxes'

export const deDockerSandboxes: DockerSandboxesTranslations = {
  title: 'Docker Cloud Sandboxes',
  modeDesc: 'Erstellen Sie mit Ihrem Docker-Hub-Login ein Gateway in einer Docker Cloud Sandbox.',
  description:
    'Führen Sie ein Hermes-Gateway in einer Docker Cloud Sandbox aus. Gedächtnis, Skills und Sitzungen liegen auf einem dauerhaften Volume, und Modellschlüssel bleiben in Ihrem Docker-Konto.',
  usernameTitle: 'Docker-Hub-Benutzername',
  usernameDesc: 'Das Docker-Konto mit Zugriff auf Cloud Sandboxes.',
  patTitle: 'Persönliches Zugriffstoken',
  patDesc: 'Im Schlüsselbund gespeichert, damit Desktop die Sandbox wecken und bei Verlust neu aufbauen kann.',
  provision: 'Gateway erstellen',
  provisioning: 'Wird erstellt…',
  steps: {
    volume: 'Zustands-Volume wird erstellt…',
    sandbox: 'Sandbox wird erstellt…',
    starting: 'Sandbox wird gestartet…',
    port: 'Gateway wird veröffentlicht…',
    login: 'Warten auf den ersten Start…',
    ready: 'Warten auf Antwort des Gateways…'
  },
  done: 'Ihr Docker-Sandbox-Gateway ist bereit und angemeldet.',
  doneSignInNeeded:
    'Ihr Docker-Sandbox-Gateway ist bereit. Nutzen Sie Anmelden in seiner Zeile mit den Zugangsdaten unten.',
  lifetimeNote:
    'Die Sandbox geht einmal am Tag in den Ruhezustand und setzt sich selbst fort, mit derselben Adresse, demselben Gedächtnis, denselben Skills und Sitzungen. Geht sie verloren, baut Desktop sie auf demselben Volume neu auf.',
  addKey:
    'Füge als Nächstes unter Einstellungen → Anbieter einen Modellschlüssel hinzu. Er wird als Secret in deinem Docker-Konto gespeichert; die Sandbox sieht ihn nie.',
  notKeptAlive: 'Dieses Gateway wird nicht automatisch neu erstellt: Hermes konnte Ihr Token nicht sicher speichern.',
  failed: step => `Das Gateway konnte nicht erstellt werden (${step}).`,
  unavailable: 'Diese Version von Hermes Desktop kann keine Cloud-Sandboxes erstellen.'
}
