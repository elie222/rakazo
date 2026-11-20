import { VoiceAccountError } from "@rakazo/adapter-kit";
import { VoiceProviderUnavailableError, voiceCatalogEntry } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";
import { markExpectedFailure } from "@rakazo/logging/hono";

/** Keep refresh failures and linked-connection refusals safe for display. */
export async function withVoiceConnection<T>(
  provider: string,
  linked: boolean,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const outage = voiceOutage(error);
    if (outage) {
      getLogger().warn("voice provider unavailable", {
        provider,
        reason: outage.cause instanceof Error ? outage.cause.name : "server error",
      });
      markExpectedFailure();
      throw outage;
    }
    if (!linked) throw error;
    const name = voiceCatalogEntry(provider)?.name ?? provider;
    if (error instanceof VoiceAccountError) {
      if (error.code === "VOICE_KEY_REJECTED") {
        throw new VoiceAccountError(
          error.code,
          `${name} didn't accept the Models connection for voice. Disconnect and paste an API key.`,
        );
      }
      throw error;
    }
    getLogger().warn("voice could not use the model connection", {
      provider,
      reason: error instanceof Error ? error.name : "unknown",
    });
    throw new VoiceAccountError(
      undefined,
      `Couldn't use the ${name} connection from Models. Try again.`,
    );
  }
}

/** A provider outage or a request it left unanswered past its deadline, as one error to wait out. */
function voiceOutage(error: unknown): VoiceProviderUnavailableError | undefined {
  if (error instanceof VoiceProviderUnavailableError) return error;
  if (error instanceof Error && error.name === "TimeoutError")
    return new VoiceProviderUnavailableError(undefined, { cause: error });
  return undefined;
}
