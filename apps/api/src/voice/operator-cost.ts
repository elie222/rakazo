import type { VoiceUsage } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { admitSpeech, settleSpeech } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { VoiceDeps } from "../calls/voice.js";

export async function withSpeechCost<T extends { usage?: VoiceUsage; providerRequestId?: string }>(
  deps: Pick<VoiceDeps, "prisma" | "env">,
  actor: Pick<Actor, "userId" | "spaceId"> & { callId?: string },
  target: { deployment: boolean; cred: { provider: string } },
  operation: "synthesize" | "transcribe",
  work: () => Promise<T>,
): Promise<T> {
  const policy = target.deployment ? deps.env?.deploymentVoice : undefined;
  if (!policy) return work();
  const id = await admitSpeech(
    deps.prisma,
    actor,
    target.cred.provider,
    operation,
    policy.pricing[operation],
  );
  // If the request fails or is interrupted, pending evidence and its reservation survive.
  // Retrying audio automatically could charge twice, so recovery requires provider evidence.
  const result = await work();
  // Intent is already durable. Losing the result would invite another paid request.
  await bestEffort(
    "Settle completed operator speech",
    settleSpeech(deps.prisma, id, result.usage, result.providerRequestId),
  );
  return result;
}
