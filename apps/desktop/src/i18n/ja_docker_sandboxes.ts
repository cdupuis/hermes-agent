import type { DockerSandboxesTranslations } from './types_docker_sandboxes'

export const jaDockerSandboxes: DockerSandboxesTranslations = {
  title: 'Docker Cloud Sandboxes',
  modeDesc: 'Docker Hub のログインで Docker Cloud Sandbox にゲートウェイを作成します。',
  description:
    'Docker Cloud Sandbox で Hermes ゲートウェイを実行します。メモリ、スキル、セッションは永続ボリュームに保存され、モデルのキーは Docker アカウントに残ります。',
  usernameTitle: 'Docker Hub ユーザー名',
  usernameDesc: 'Cloud Sandboxes を利用できる Docker アカウント。',
  patTitle: '個人アクセストークン',
  patDesc: 'Desktop が期限切れ前にサンドボックスを作り直せるよう、キーチェーンに保存します。',
  provision: 'ゲートウェイを作成',
  provisioning: '作成中…',
  steps: {
    volume: '状態ボリュームを作成中…',
    sandbox: 'サンドボックスを作成中…',
    starting: 'サンドボックスを起動中…',
    port: 'ゲートウェイを公開中…',
    login: '初回起動を待っています…',
    ready: 'ゲートウェイの応答を待っています…'
  },
  done: 'Docker Sandbox ゲートウェイの準備ができ、サインイン済みです。',
  doneSignInNeeded:
    'Docker Sandbox ゲートウェイの準備ができました。行の「サインイン」から下のログイン情報で入ってください。',
  lifetimeNote:
    'クラウドサンドボックスの寿命は最長 24 時間です。Desktop は期限切れ前に同じボリュームで作り直すため、ゲートウェイのメモリ、スキル、セッションは保持されます。',
  notKeptAlive: 'このゲートウェイは自動で作り直されません。Hermes がトークンを安全に保存できませんでした。',
  failed: step => `ゲートウェイを作成できませんでした（${step}）。`,
  unavailable: 'このビルドの Hermes Desktop ではクラウドサンドボックスを作成できません。'
}
