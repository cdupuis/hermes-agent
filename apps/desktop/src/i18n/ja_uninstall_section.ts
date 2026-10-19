import type { UninstallSectionTranslations } from './types_uninstall_section'

// A partial overlay, like the locale it came from: missing keys fall back to English.
export const jaUninstallSection: Partial<UninstallSectionTranslations> = {
  dangerZone: '危険ゾーン',
  checkingInstalled: 'インストール内容を確認中…',
  uninstallHermes: 'Hermes をアンインストール',
  chooseHowMuch:
    '削除する範囲を選択してください。完了するためにアプリが閉じます。インストーラーを開き直せばいつでも戻れます。',
  confirmUninstall: 'アンインストールの確認',
  confirmBody: what => `${what} が削除されます。この操作は取り消せません。`,
  appLabel: 'アプリ：',
  couldNotStart: 'アンインストールを開始できませんでした。',
  uninstalling: 'アンインストール中…',
  yesUninstall: 'はい、アンインストール',
  options: {
    gui: {
      title: 'Chat GUI のみアンインストール',
      description: 'このデスクトップアプリを削除します。Hermes エージェント、設定、チャットはすべて残ります。',
      consequence: 'デスクトップ Chat GUI（このアプリとそのデータ）'
    },
    lite: {
      title: 'GUI とエージェントをアンインストール、データは保持',
      description:
        'アプリと Hermes エージェントを削除しますが、将来の再インストールに備えて設定・チャット・シークレットは保持します。',
      consequence: 'Chat GUI と Hermes エージェント（設定・チャット・シークレットは保持）'
    },
    full: {
      title: 'すべてアンインストール',
      description:
        'アプリ、エージェント、すべてのユーザーデータ（設定、チャット、定期ジョブ、シークレット、ログ）を削除します。',
      consequence: 'すべて——Chat GUI、Hermes エージェント、およびすべての設定・チャット・シークレット・ログ'
    }
  }
}
