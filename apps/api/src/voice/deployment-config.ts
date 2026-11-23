import {
  isVoiceProviderId,
  voiceDeploymentConnectionSupported,
  voiceDeploymentModelSupported,
  voiceTranscriptionUsageUnit,
} from "@rakazo/adapters";
import { z } from "zod";

const price = z
  .object({
    model: z.string().trim().min(1),
    unit: z.enum(["characters", "seconds", "tokens"]),
    microsPerUnit: z.number().nonnegative().finite(),
    // A bounded reservation, retained when a provider does not return usage.
    maxRequestMicros: z.number().int().positive().safe(),
    source: z.string().url(),
    version: z.string().min(1),
  })
  .strict();

const httpEndpoint = z.url({ protocol: /^https?$/ });

const deploymentVoiceSchema = z
  .object({
    provider: z.string().min(1),
    connection: z
      .object({
        plaintext: z.string().trim().min(1),
        baseUrl: httpEndpoint.optional(),
        sttBaseUrl: httpEndpoint.optional(),
        sttApiKey: z.string().optional(),
        ttsModel: z.string().trim().min(1).optional(),
        sttModel: z.string().trim().min(1).optional(),
      })
      .strict(),
    voiceId: z.string().min(1),
    allowUnmeteredUsage: z.boolean().optional(),
    pricing: z.object({ synthesize: price, transcribe: price }).strict(),
  })
  .strict();

export type DeploymentVoice = z.infer<typeof deploymentVoiceSchema>;

/** Deliberately omit validation details: they can contain secret input values. */
export function deploymentVoiceFromEnv(
  value: string | undefined,
  allowPrivateEndpoint = false,
): DeploymentVoice | undefined {
  if (!value) return undefined;
  try {
    const config = deploymentVoiceSchema.parse(JSON.parse(value));
    const connection = {
      ...config.connection,
      ttsModel: config.pricing.synthesize.model,
      sttModel: config.pricing.transcribe.model,
    };
    if (
      !isVoiceProviderId(config.provider) ||
      !voiceDeploymentConnectionSupported(config.provider, connection, { allowPrivateEndpoint }) ||
      !voiceDeploymentModelSupported(config.provider, config.pricing.synthesize.model) ||
      !voiceDeploymentModelSupported(
        config.provider,
        config.pricing.transcribe.model,
        "transcribe",
      ) ||
      (config.connection.ttsModel &&
        config.connection.ttsModel !== config.pricing.synthesize.model) ||
      (config.connection.sttModel && config.connection.sttModel !== config.pricing.transcribe.model)
    ) {
      throw new Error("Invalid deployment speech configuration");
    }
    const { synthesize, transcribe } = config.pricing;
    const reported = voiceTranscriptionUsageUnit(config.provider, transcribe.model);
    if (
      (reported !== undefined && reported !== transcribe.unit) ||
      ((synthesize.unit !== "characters" || reported === undefined || reported === "tokens") &&
        config.allowUnmeteredUsage !== true)
    ) {
      throw new Error("Invalid deployment speech metering policy");
    }
    return {
      ...config,
      connection,
    };
  } catch {
    throw new Error("Invalid DEPLOYMENT_VOICE connection or pricing policy");
  }
}
