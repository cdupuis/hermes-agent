import type { DockerSandboxesTranslations } from './types_docker_sandboxes'

export const arDockerSandboxes: DockerSandboxesTranslations = {
  title: 'Docker Cloud Sandboxes',
  modeDesc: 'أنشئ بوابة في Docker Cloud Sandbox باستخدام بيانات دخول Docker Hub.',
  description:
    'شغّل بوابة Hermes داخل Docker Cloud Sandbox. تبقى ذاكرتها ومهاراتها وجلساتها على وحدة تخزين دائمة، وتبقى مفاتيح النماذج في حساب Docker الخاص بك.',
  usernameTitle: 'اسم مستخدم Docker Hub',
  usernameDesc: 'حساب Docker الذي لديه وصول إلى Cloud Sandboxes.',
  patTitle: 'رمز الوصول الشخصي',
  patDesc: 'يُحفظ في سلسلة المفاتيح ليتمكن Desktop من إيقاظ بيئة الحماية وإعادة بنائها إذا فُقدت.',
  provision: 'إنشاء البوابة',
  provisioning: 'جارٍ الإنشاء…',
  steps: {
    volume: 'جارٍ إنشاء وحدة تخزين الحالة…',
    sandbox: 'جارٍ إنشاء بيئة الحماية…',
    starting: 'جارٍ تشغيل بيئة الحماية…',
    port: 'جارٍ نشر البوابة…',
    login: 'بانتظار الإقلاع الأول…',
    ready: 'بانتظار استجابة البوابة…'
  },
  done: 'بوابة Docker Sandbox جاهزة ومسجّل الدخول إليها.',
  doneSignInNeeded: 'بوابة Docker Sandbox جاهزة. استخدم تسجيل الدخول في صفها ببيانات الدخول أدناه.',
  lifetimeNote:
    'تدخل بيئة الحماية في السبات مرة يوميًا وتستأنف تلقائيًا بالعنوان نفسه والذاكرة والمهارات والجلسات نفسها. وإذا فُقدت، يعيد Desktop بناءها على وحدة التخزين نفسها.',
  addKey:
    'بعد ذلك، أضف مفتاح نموذج من الإعدادات ← المزوّدون. يُخزَّن كسرّ في حساب Docker الخاص بك، ولا تراه بيئة الحماية أبدًا.',
  notKeptAlive: 'لن تُعاد إنشاء هذه البوابة تلقائيًا: تعذّر على Hermes حفظ الرمز بأمان.',
  failed: step => `تعذّر إنشاء البوابة (${step}).`,
  unavailable: 'لا يمكن لهذا الإصدار من Hermes Desktop إنشاء بيئات حماية سحابية.'
}
