import type { DockerSandboxesTranslations } from './types_docker_sandboxes'

export const zhDockerSandboxes: DockerSandboxesTranslations = {
  title: 'Docker Cloud Sandboxes',
  modeDesc: '使用 Docker Hub 登录信息在 Docker Cloud Sandbox 中创建网关。',
  description:
    '在 Docker Cloud Sandbox 中运行 Hermes 网关。它的记忆、技能和会话保存在持久卷上，模型密钥留在你的 Docker 账户中。',
  usernameTitle: 'Docker Hub 用户名',
  usernameDesc: '拥有 Cloud Sandboxes 访问权限的 Docker 账户。',
  patTitle: '个人访问令牌',
  patDesc: '保存在钥匙串中，以便 Desktop 在沙盒过期前重新创建它。',
  provision: '创建网关',
  provisioning: '正在创建…',
  steps: {
    volume: '正在创建状态卷…',
    sandbox: '正在创建沙盒…',
    starting: '正在启动沙盒…',
    port: '正在发布网关…',
    login: '正在等待首次启动…',
    ready: '正在等待网关响应…'
  },
  done: 'Docker Sandbox 网关已就绪并已登录。',
  doneSignInNeeded: 'Docker Sandbox 网关已就绪。请在它所在行点击登录，并使用下方的登录信息。',
  lifetimeNote: '云沙盒最长存在 24 小时。Desktop 会在过期前于同一卷上重新创建它，网关会保留记忆、技能和会话。',
  notKeptAlive: '此网关不会自动重新创建：Hermes 无法安全地保存你的令牌。',
  failed: step => `无法创建网关（${step}）。`,
  unavailable: '此版本的 Hermes Desktop 无法创建云沙盒。'
}
