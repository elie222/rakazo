import { VoiceAccountError } from "@rakazo/adapter-kit";
import { VoiceProviderUnavailableError, voiceCatalogEntry } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";
import { markExpectedFailure } from "@rakazo/logging/hono";

/** Mark provider outages and give actionable guidance for rejected linked connections. */
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
    if (linked && error instanceof VoiceAccountError && error.code === "VOICE_KEY_REJECTED") {
      const name = voiceCatalogEntry(provider)?.name ?? provider;
      throw new VoiceAccountError(
        error.code,
        `${name} didn't accept the Models connection for voice. Disconnect and paste an API key.`,
      );
    }
    throw error;
  }
}

/** A provider outage or a request it left unanswered past its deadline, as one error to wait out. */
function voiceOutage(error: unknown): VoiceProviderUnavailableError | undefined {
  if (error instanceof VoiceProviderUnavailableError) return error;
  if (error instanceof Error && error.name === "TimeoutError")
    return new VoiceProviderUnavailableError(undefined, { cause: error });
  return undefined;
}
