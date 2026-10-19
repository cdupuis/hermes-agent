import type { DockerSandboxesTranslations } from './types_docker_sandboxes'

export const esDockerSandboxes: DockerSandboxesTranslations = {
  title: 'Docker Cloud Sandboxes',
  modeDesc: 'Crea una pasarela en una Docker Cloud Sandbox con tu acceso de Docker Hub.',
  description:
    'Ejecuta una pasarela de Hermes en una Docker Cloud Sandbox. Su memoria, habilidades y sesiones viven en un volumen persistente, y las claves de los modelos se quedan en tu cuenta de Docker.',
  usernameTitle: 'Usuario de Docker Hub',
  usernameDesc: 'La cuenta de Docker con acceso a Cloud Sandboxes.',
  patTitle: 'Token de acceso personal',
  patDesc: 'Se guarda en tu llavero para que Desktop pueda volver a crear la sandbox antes de que caduque.',
  provision: 'Crear pasarela',
  provisioning: 'Creando…',
  steps: {
    volume: 'Creando el volumen de estado…',
    sandbox: 'Creando la sandbox…',
    starting: 'Iniciando la sandbox…',
    port: 'Publicando la pasarela…',
    login: 'Esperando el primer arranque…',
    ready: 'Esperando a que responda la pasarela…'
  },
  done: 'Tu pasarela Docker Sandbox está lista y con sesión iniciada.',
  doneSignInNeeded: 'Tu pasarela Docker Sandbox está lista. Usa Iniciar sesión en su fila con el acceso de abajo.',
  lifetimeNote:
    'Las sandboxes en la nube duran como máximo 24 horas. Desktop vuelve a crear esta en el mismo volumen antes de que caduque; la pasarela conserva su memoria, habilidades y sesiones.',
  notKeptAlive: 'Esta pasarela no se recreará automáticamente: Hermes no pudo guardar tu token de forma segura.',
  failed: step => `No se pudo crear la pasarela (${step}).`,
  unavailable: 'Esta versión de Hermes Desktop no puede crear sandboxes en la nube.'
}
