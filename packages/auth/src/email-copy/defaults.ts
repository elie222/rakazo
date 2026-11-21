/**
 * Plain copy for each lifecycle and marketing email, in English. A deployment may replace any
 * string, in any app language, from its own copy directory (hosted-copy.ts); a replacement keeps
 * the `{placeholders}` of the string it replaces. Adding an email or key here comes first.
 */
export const EMAIL_COPY_DEFAULTS = {
  welcome: {
    subject: "Welcome to Rakazo",
    intro: "Your Rakazo account is ready.",
    appsTitle: "Apps",
    apps: "Rakazo is available on {platforms}.",
    communityTitle: "Community",
    community: "Get help and share feedback on {discord}.",
    starTitle: "Source code",
    star: "Rakazo is open source: {star}.",
    starLink: "view it on GitHub",
    closing: "Reply to this email if you have questions.",
    signature: "The Rakazo team",
  },
  referral: {
    subject: "Invite a friend to Rakazo",
    body: "Invite a friend to Rakazo and they get {weeks} weeks free.",
    link: "Open Rakazo",
    afterLink: "and choose Invite friends to get your link.",
    signature: "The Rakazo team",
  },
  "model-connection": {
    subject: "Connect a model to use Rakazo",
    intro: "Your bots can reply once a model is connected.",
    connect: "Sign in with your {subscriptions} subscription, or paste an API key.",
    button: "Connect a model",
  },
  "agent-import": {
    subject: "Import an assistant into Rakazo",
    intro: "Rakazo can import an assistant from {assistants} as a new bot.",
    other: "Other assistants can be imported from a prompt reply.",
    button: "Import an agent",
  },
} as const satisfies Record<string, Record<string, string>>;

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

export type EmailCopyId = keyof typeof EMAIL_COPY_DEFAULTS;
