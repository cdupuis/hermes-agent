import type { DockerSandboxesTranslations } from './types_docker_sandboxes'

export const ruDockerSandboxes: DockerSandboxesTranslations = {
  title: 'Docker Cloud Sandboxes',
  modeDesc: 'Создайте шлюз в Docker Cloud Sandbox по учётной записи Docker Hub.',
  description:
    'Запустите шлюз Hermes в Docker Cloud Sandbox. Его память, навыки и сессии хранятся на постоянном томе, а ключи моделей остаются в вашей учётной записи Docker.',
  usernameTitle: 'Имя пользователя Docker Hub',
  usernameDesc: 'Учётная запись Docker с доступом к Cloud Sandboxes.',
  patTitle: 'Персональный токен доступа',
  patDesc: 'Хранится в связке ключей, чтобы Desktop мог пересоздать песочницу до истечения срока.',
  provision: 'Создать шлюз',
  provisioning: 'Создание…',
  steps: {
    volume: 'Создание тома состояния…',
    sandbox: 'Создание песочницы…',
    starting: 'Запуск песочницы…',
    port: 'Публикация шлюза…',
    login: 'Ожидание первой загрузки…',
    ready: 'Ожидание ответа шлюза…'
  },
  done: 'Шлюз Docker Sandbox готов, вход выполнен.',
  doneSignInNeeded: 'Шлюз Docker Sandbox готов. Нажмите «Войти» в его строке и используйте данные ниже.',
  lifetimeNote:
    'Облачные песочницы живут не дольше 24 часов. Desktop пересоздаёт эту на том же томе до истечения срока, поэтому шлюз сохраняет память, навыки и сессии.',
  notKeptAlive: 'Этот шлюз не будет пересоздаваться автоматически: Hermes не смог надёжно сохранить токен.',
  failed: step => `Не удалось создать шлюз (${step}).`,
  unavailable: 'Эта сборка Hermes Desktop не умеет создавать облачные песочницы.'
}
