import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { ResendEmailProvider } from "./resend-email.js";
import { SmtpEmailProvider } from "./smtp-email.js";

export function configuredEmailProvider(env: {
  emailProvider?: string;
  emailApiKey?: string;
  emailFrom?: string;
  emailReplyTo?: string;
  smtpUrl?: string;
}): TransactionalEmailProvider | undefined {
  // Preserve existing SMTP deployments when no provider is selected explicitly.
  const provider = env.emailProvider ?? (env.smtpUrl ? "smtp" : "none");
  switch (provider) {
    case "none":
      return undefined;
    case "smtp":
      return new SmtpEmailProvider({
        url: env.smtpUrl ?? "",
        from: env.emailFrom ?? "",
        replyTo: env.emailReplyTo,
      });
    case "resend":
      return new ResendEmailProvider({
        apiKey: env.emailApiKey ?? "",
        from: env.emailFrom ?? "",
        replyTo: env.emailReplyTo,
      });
    default:
      throw new Error("EMAIL_PROVIDER must be none, smtp, or resend");
  }
}
