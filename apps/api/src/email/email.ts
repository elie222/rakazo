import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { EmailRecipientRejectedError } from "@rakazo/adapter-kit";
import { configuredEmailProvider as providerFor } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";
import type { AppEnv } from "../env.js";

export function configuredEmailProvider(
  env: Pick<AppEnv, "emailProvider" | "emailApiKey" | "emailFrom" | "emailReplyTo" | "smtpUrl">,
): TransactionalEmailProvider | undefined {
  return providerFor({
    provider: env.emailProvider,
    apiKey: env.emailApiKey,
    from: env.emailFrom,
    replyTo: env.emailReplyTo,
    smtpUrl: env.smtpUrl,
  });
}

/** Logs a failed send; an address the provider refused is the recipient's problem, not ours. */
export function emailErrorLogger(message: string) {
  return (error: unknown) => {
    if (error instanceof EmailRecipientRejectedError) {
      getLogger().warn(message, { "error.message": error.message });
    } else getLogger().error(message, error);
  };
}
