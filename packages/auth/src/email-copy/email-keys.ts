/**
 * The lifecycle emails whose wording a deployment supplies (deployment-copy.ts), each key's
 * `{placeholders}`. This repository holds no wording for them; adding an email or key starts here.
 */
export const EMAIL_COPY_KEYS = {
  welcome: {
    subject: [],
    intro: [],
    appsTitle: [],
    apps: ["platforms"],
    communityTitle: [],
    community: ["discord"],
    starTitle: [],
    star: ["star"],
    starLink: [],
    closing: [],
    signature: [],
  },
  referral: {
    subject: [],
    body: ["weeks"],
    link: [],
    afterLink: [],
    signature: [],
  },
  "model-connection": {
    subject: [],
    intro: [],
    connect: ["subscriptions"],
    button: [],
  },
  "agent-import": {
    subject: [],
    intro: ["assistants"],
    other: [],
    button: [],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

/** The app languages emails are written in; email.tsx has a catalog for each one but English. */
export const EMAIL_LOCALES = [
  "en",
  "de",
  "es",
  "fr",
  "he",
  "hi",
  "ja",
  "ko",
  "nl",
  "pl",
  "pt-BR",
  "ru",
  "tr",
  "zh-CN",
  "zh-TW",
] as const;

export type EmailCopyId = keyof typeof EMAIL_COPY_KEYS;
