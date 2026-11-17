import { isVoiceProviderId } from "@rakazo/adapters";
import { z } from "zod";

const price = z
  .object({
    model: z.string().min(1),
    unit: z.enum(["characters", "seconds", "tokens"]),
    microsPerUnit: z.number().nonnegative().finite(),
    // A bounded reservation, retained when a provider does not return usage.
    maxRequestMicros: z.number().int().positive().safe(),
    source: z.string().url(),
    version: z.string().min(1),
  })
  .strict();

const deploymentVoiceSchema = z
  .object({
    provider: z.string().min(1),
    connection: z
      .object({
        plaintext: z.string(),
        baseUrl: z.string().optional(),
        sttBaseUrl: z.string().optional(),
        sttApiKey: z.string().optional(),
        ttsModel: z.string().optional(),
        sttModel: z.string().optional(),
      })
      .strict(),
    voiceId: z.string().min(1),
    pricing: z.object({ synthesize: price, transcribe: price }).strict(),
  })
  .strict();

export type DeploymentVoice = z.infer<typeof deploymentVoiceSchema>;

/** Deliberately omit validation details: they can contain secret input values. */
export function deploymentVoiceFromEnv(value: string | undefined): DeploymentVoice | undefined {
  if (!value) return undefined;
  try {
    const config = deploymentVoiceSchema.parse(JSON.parse(value));
    if (
      !isVoiceProviderId(config.provider) ||
      (config.connection.ttsModel &&
        config.connection.ttsModel !== config.pricing.synthesize.model) ||
      (config.connection.sttModel && config.connection.sttModel !== config.pricing.transcribe.model)
    ) {
      throw new Error("Invalid deployment speech configuration");
    }
    return config;
  } catch {
    throw new Error("Invalid DEPLOYMENT_VOICE connection or pricing policy");
  }
}
