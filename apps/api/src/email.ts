import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { configuredEmailProvider as providerFor } from "@rakazo/adapters";
import type { AppEnv } from "./env.js";

export function configuredEmailProvider(
  env: Pick<
    AppEnv,
    "emailProvider" | "emailApiKey" | "emailAccountId" | "emailFrom" | "emailReplyTo" | "smtpUrl"
  >,
): TransactionalEmailProvider | undefined {
  return providerFor({
    provider: env.emailProvider,
    apiKey: env.emailApiKey,
    accountId: env.emailAccountId,
    from: env.emailFrom,
    replyTo: env.emailReplyTo,
    smtpUrl: env.smtpUrl,
  });
}
