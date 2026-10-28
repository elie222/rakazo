import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { ResendEmailProvider, SmtpEmailProvider } from "@rakazo/adapters";
import type { AppEnv } from "./env.js";

export function configuredEmailProvider(
  env: Pick<AppEnv, "emailProvider" | "emailApiKey" | "emailFrom" | "emailReplyTo" | "smtpUrl">,
): TransactionalEmailProvider | undefined {
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
