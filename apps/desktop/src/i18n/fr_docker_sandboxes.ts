import type { DockerSandboxesTranslations } from './types_docker_sandboxes'

export const frDockerSandboxes: DockerSandboxesTranslations = {
  title: 'Docker Cloud Sandboxes',
  modeDesc: 'Créez une passerelle dans une Docker Cloud Sandbox avec votre identifiant Docker Hub.',
  description:
    'Exécutez une passerelle Hermes dans une Docker Cloud Sandbox. Sa mémoire, ses compétences et ses sessions résident sur un volume persistant, et les clés des modèles restent dans votre compte Docker.',
  usernameTitle: 'Nom d’utilisateur Docker Hub',
  usernameDesc: 'Le compte Docker disposant de l’accès à Cloud Sandboxes.',
  patTitle: 'Jeton d’accès personnel',
  patDesc: 'Conservé dans votre trousseau pour que Desktop puisse recréer la sandbox avant son expiration.',
  provision: 'Créer la passerelle',
  provisioning: 'Création…',
  steps: {
    volume: 'Création du volume d’état…',
    sandbox: 'Création de la sandbox…',
    starting: 'Démarrage de la sandbox…',
    port: 'Publication de la passerelle…',
    login: 'Attente du premier démarrage…',
    ready: 'Attente de la réponse de la passerelle…'
  },
  done: 'Votre passerelle Docker Sandbox est prête et connectée.',
  doneSignInNeeded:
    'Votre passerelle Docker Sandbox est prête. Utilisez Se connecter sur sa ligne avec l’identifiant ci-dessous.',
  lifetimeNote:
    'Les sandboxes cloud durent au plus 24 heures. Desktop recrée celle-ci sur le même volume avant son expiration ; la passerelle garde sa mémoire, ses compétences et ses sessions.',
  notKeptAlive:
    'Cette passerelle ne sera pas recréée automatiquement : Hermes n’a pas pu stocker votre jeton de façon sécurisée.',
  failed: step => `Impossible de créer la passerelle (${step}).`,
  unavailable: 'Cette version de Hermes Desktop ne peut pas créer de sandboxes cloud.'
}
