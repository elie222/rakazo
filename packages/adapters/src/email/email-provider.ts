import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { ResendEmailProvider } from "../providers/email/resend/resend-email.js";
import { SmtpEmailProvider } from "../providers/email/smtp/smtp-email.js";

export type EmailProviderConfig = {
  provider?: string;
  apiKey?: string;
  from?: string;
  replyTo?: string;
  smtpUrl?: string;
};

/** The EMAIL_* and SMTP_URL settings, trimmed, with a blank value unset. */
export function emailProviderConfigFromEnv(
  source: Record<string, string | undefined>,
): EmailProviderConfig {
  // Each setting is named in full so the deployment's environment allowlist check can find it.
  const value = (setting: string | undefined) => setting?.trim() || undefined;
  return {
    provider: value(source.EMAIL_PROVIDER),
    apiKey: value(source.EMAIL_API_KEY),
    from: value(source.EMAIL_FROM),
    replyTo: value(source.EMAIL_REPLY_TO),
    smtpUrl: value(source.SMTP_URL),
  };
}

/** The configured outbound email provider, in the API and the worker alike; undefined when none. */
export function configuredEmailProvider(
  config: EmailProviderConfig,
): TransactionalEmailProvider | undefined {
  // Preserve existing SMTP deployments when no provider is selected explicitly.
  const provider = config.provider ?? (config.smtpUrl ? "smtp" : "none");
  switch (provider) {
    case "none":
      return undefined;
    case "smtp":
      return new SmtpEmailProvider({
        url: config.smtpUrl ?? "",
        from: config.from ?? "",
        replyTo: config.replyTo,
      });
    case "resend":
      return new ResendEmailProvider({
        apiKey: config.apiKey ?? "",
        from: config.from ?? "",
        replyTo: config.replyTo,
      });
    default:
      throw new Error("EMAIL_PROVIDER must be none, smtp, or resend");
  }
}

/** Bot mail has its own SMTP connection and never falls back to account-email credentials. */
export function configuredBotEmailProvider(config: {
  smtpUrl?: string;
  domain?: string;
}): TransactionalEmailProvider | undefined {
  if (!config.smtpUrl) return undefined;
  if (!config.domain) throw new Error("BOT_EMAIL_SMTP_URL requires INBOUND_EMAIL_DOMAIN");
  try {
    return new SmtpEmailProvider({ url: config.smtpUrl, from: `bot@${config.domain}` });
  } catch (cause) {
    throw new Error("BOT_EMAIL_SMTP_URL could not be configured", { cause });
  }
}
