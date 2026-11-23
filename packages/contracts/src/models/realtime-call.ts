import * as z from "zod";

/** Settings a realtime model may honour. The settings page shows only the ones it lists. */
export const REALTIME_CALL_CAPABILITIES = [
  "voice",
  "speed",
  "patience",
  "noiseReduction",
  "language",
  "thinking",
  "vadThreshold",
  "silenceMs",
  "maxOutputTokens",
] as const;
export const RealtimeCallCapabilitySchema = z.enum(REALTIME_CALL_CAPABILITIES);
export type RealtimeCallCapability = z.infer<typeof RealtimeCallCapabilitySchema>;

/**
 * Provider-neutral call settings; each provider maps them to its own session options.
 * A blank model keeps the standard call, so realtime is always an explicit choice, and every
 * option left unset sends nothing, so the provider keeps today's behaviour.
 */
export const RealtimeCallSettingsSchema = z.object({
  provider: z.string().trim().max(64).default(""),
  model: z.string().trim().max(100).default(""),
  voiceId: z.string().trim().max(120).optional(),
  /** Playback rate; 1 is the provider's normal pace. */
  speed: z.number().min(0.25).max(1.5).optional(),
  /** Ends a turn by meaning instead of by a quiet gap, waiting longer the more patient it is. */
  patience: z.enum(["patient", "balanced", "quick"]).optional(),
  noiseReduction: z.enum(["headset", "room", "off"]).optional(),
  /** ISO 639-1 code of the language the caller speaks. */
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
  thinking: z.enum(["fast", "balanced", "thorough"]).optional(),
  /** Quiet-gap turn ending, used while no patience is chosen. */
  vadThreshold: z.number().min(0).max(1).optional(),
  silenceMs: z.number().int().min(200).max(3000).optional(),
  maxOutputTokens: z.number().int().min(1).max(4096).optional(),
});
export type RealtimeCallSettings = z.infer<typeof RealtimeCallSettingsSchema>;

export const RealtimeCallModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  capabilities: z.array(RealtimeCallCapabilitySchema),
});
export type RealtimeCallModel = z.infer<typeof RealtimeCallModelSchema>;

export const RealtimeCallProviderSchema = z.object({
  provider: z.string(),
  models: z.array(RealtimeCallModelSchema),
  voices: z.array(z.string()),
});

export const RealtimeCallStateSchema = z.object({
  /** False while the server has calls switched off or no connected provider can run them. */
  available: z.boolean(),
  settings: RealtimeCallSettingsSchema,
  providers: z.array(RealtimeCallProviderSchema),
});
export type RealtimeCallState = z.infer<typeof RealtimeCallStateSchema>;

/** Stored settings that no longer parse fall back to the standard call instead of failing. */
export function parseRealtimeCallSettings(value: unknown): RealtimeCallSettings {
  const parsed = RealtimeCallSettingsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : RealtimeCallSettingsSchema.parse({});
}

/** The provider and model a call should use, or null for the standard call. */
export function chosenRealtimeModel(state: RealtimeCallState) {
  const { settings } = state;
  if (!state.available || !settings.model) return null;
  const entry = settings.provider
    ? state.providers.find((candidate) => candidate.provider === settings.provider)
    : state.providers[0];
  const model = entry?.models.find((candidate) => candidate.id === settings.model);
  return entry && model ? { provider: entry.provider, model, voices: entry.voices } : null;
}
