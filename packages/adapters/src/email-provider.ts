import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { ResendEmailProvider } from "./resend-email.js";
import { SmtpEmailProvider } from "./smtp-email.js";

export type EmailProviderConfig = {
  provider?: string;
  apiKey?: string;
  from?: string;
  replyTo?: string;
  smtpUrl?: string;
};

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
