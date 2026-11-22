import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { EmailRecipientRejectedError } from "@rakazo/adapter-kit";
import {
  configuredBotEmailProvider,
  EmailEmulator,
  configuredEmailProvider as providerFor,
} from "@rakazo/adapters";
import { emailCopyAvailable } from "@rakazo/auth";
import { isLocalhostOrLoopbackIp, LIFECYCLE_EMAIL_KINDS } from "@rakazo/contracts";
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

/** The API's account mail, the local emulator standing in for it, and bots' own mail. */
export function apiEmail(
  env: AppEnv,
  { override, singleProcess }: { override?: TransactionalEmailProvider; singleProcess: boolean },
) {
  const configuredEmail = override ?? configuredEmailProvider(env);
  const localEmailEmulator =
    !configuredEmail && env.emailEmulator
      ? new EmailEmulator((message) => {
          getLogger().info("email emulator captured message", {
            "email.subject": message.subject,
          });
        })
      : undefined;
  if (localEmailEmulator && !isLocalhostOrLoopbackIp(env.apiHost)) {
    throw new Error("EMAIL_EMULATOR requires API_HOST to be a loopback host");
  }
  const email: TransactionalEmailProvider | undefined = configuredEmail ?? localEmailEmulator;
  // Lifecycle mail goes out only where the deployment supplies its copy. The worker sends it, and
  // the local emulator lives in this process, so the emulator counts only in single-process mode.
  const lifecycleEmailKinds =
    (configuredEmail ?? (singleProcess ? email : undefined))
      ? LIFECYCLE_EMAIL_KINDS.filter((kind) => emailCopyAvailable(kind))
      : [];
  const botEmail: TransactionalEmailProvider | undefined =
    configuredBotEmailProvider({
      smtpUrl: env.botEmailSmtpUrl,
      domain: env.inboundEmail?.domain,
    }) ?? localEmailEmulator;
  return { email, localEmailEmulator, lifecycleEmailKinds, botEmail };
}
