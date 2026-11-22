import type { VoiceUsage } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { admitSpeech, settleSpeech } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { VoiceDeps } from "../calls/voice.js";
import type { DeploymentVoice } from "./deployment-config.js";
import { requireDeploymentVoiceConsent } from "./deployment-consent.js";

type SpeechRequest = { operation: "synthesize"; text: string } | { operation: "transcribe" };

export const TRANSCRIBE: SpeechRequest = { operation: "transcribe" };

export async function withSpeechCost<T extends { usage?: VoiceUsage; providerRequestId?: string }>(
  deps: Pick<VoiceDeps, "prisma" | "env">,
  actor: Pick<Actor, "userId" | "spaceId"> & { callId?: string },
  target: { deployment: boolean; cred: { provider: string } },
  request: SpeechRequest,
  work: () => Promise<T>,
): Promise<T> {
  const { operation } = request;
  const policy = target.deployment ? deps.env?.deploymentVoice : undefined;
  if (!policy) return work();
  await requireDeploymentVoiceConsent(deps.prisma, actor, policy, operation);
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
  const settled = await bestEffort(
    "Settle completed operator speech",
    settleSpeech(
      deps.prisma,
      id,
      measuredUsage(policy.pricing, request, result.usage),
      result.providerRequestId,
    ).then(() => true),
  );
  if (!settled)
    getLogger().error("Operator speech settlement requires reconciliation", {
      speechCostId: id,
      provider: target.cred.provider,
      operation,
      providerRequestId: result.providerRequestId,
    });
  return result;
}

/** Every character-priced provider bills the text it is sent, so the server counts it once for all. */
function measuredUsage(
  pricing: DeploymentVoice["pricing"],
  request: SpeechRequest,
  reported: VoiceUsage | undefined,
): VoiceUsage | undefined {
  if (request.operation !== "synthesize" || pricing.synthesize.unit !== "characters")
    return reported;
  return {
    model: pricing.synthesize.model,
    unit: "characters",
    units: Array.from(request.text).length,
  };
}
