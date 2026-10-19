import type { DockerSandboxesTranslations } from './types_docker_sandboxes'

export const zhHantDockerSandboxes: DockerSandboxesTranslations = {
  title: 'Docker Cloud Sandboxes',
  modeDesc: '使用 Docker Hub 登入資訊在 Docker Cloud Sandbox 中建立閘道。',
  description:
    '在 Docker Cloud Sandbox 中執行 Hermes 閘道。它的記憶、技能與工作階段存放在永久磁碟區，模型金鑰留在你的 Docker 帳戶中。',
  usernameTitle: 'Docker Hub 使用者名稱',
  usernameDesc: '擁有 Cloud Sandboxes 存取權的 Docker 帳戶。',
  patTitle: '個人存取權杖',
  patDesc: '儲存在鑰匙圈中，讓 Desktop 能在沙盒過期前重新建立它。',
  provision: '建立閘道',
  provisioning: '建立中…',
  steps: {
    volume: '正在建立狀態磁碟區…',
    sandbox: '正在建立沙盒…',
    starting: '正在啟動沙盒…',
    port: '正在發布閘道…',
    login: '正在等待首次開機…',
    ready: '正在等待閘道回應…'
  },
  done: 'Docker Sandbox 閘道已就緒並已登入。',
  doneSignInNeeded: 'Docker Sandbox 閘道已就緒。請在它所在列點選登入，並使用下方的登入資訊。',
  lifetimeNote:
    '雲端沙盒最長存在 24 小時。Desktop 會在過期前於同一磁碟區上重新建立它，閘道會保留記憶、技能與工作階段。',
  notKeptAlive: '此閘道不會自動重新建立：Hermes 無法安全地儲存你的權杖。',
  failed: step => `無法建立閘道（${step}）。`,
  unavailable: '此版本的 Hermes Desktop 無法建立雲端沙盒。'
}
