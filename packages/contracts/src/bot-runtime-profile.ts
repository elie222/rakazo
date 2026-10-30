import * as z from "zod";

const Identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);

/** Settings are data only. Key names that commonly carry credentials are not accepted. */
const SettingsKey = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (key) => !/(secret|password|passwd|token|credential|api[-_]?key|private[-_]?key)/i.test(key),
    "Secret values are not allowed in extension settings",
  );
function settingValue(depth: number): z.ZodType<unknown> {
  const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
  if (depth === 0) return scalar;
  return z.union([
    scalar,
    z.array(settingValue(depth - 1)).max(100),
    z
      .record(SettingsKey, settingValue(depth - 1))
      .refine((value) => Object.keys(value).length <= 100),
  ]);
}
const JsonValue = settingValue(5);
export const BotExtensionSettings = z
  .record(SettingsKey, JsonValue)
  .refine((value) => Object.keys(value).length <= 100, "Too many extension settings")
  .refine((value) => JSON.stringify(value).length <= 16_384, "Extension settings are too large");

export const BotRuntimePersona = z
  .object({
    persona: z.string().max(20_000).default(""),
  })
  .strict();

export const BotRuntimeSkillSelection = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("legacy-library") }).strict(),
  z
    .object({ mode: z.literal("explicit"), skillIds: z.array(Identifier).max(100).default([]) })
    .strict()
    .refine(
      (selection) => new Set(selection.skillIds).size === selection.skillIds.length,
      "Skill IDs must be unique",
    ),
]);

export const BotRuntimeExtensionReference = z
  .object({
    extensionId: Identifier,
    version: z.string().trim().min(1).max(128),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/, "Use an immutable SHA-256 digest"),
    settings: BotExtensionSettings.default({}),
  })
  .strict();

export const BotRuntimeLearningPolicy = z
  .object({
    mode: z.enum(["off", "proposals-only", "automatic-private"]).default("off"),
    maxReviewsPerDay: z.number().int().min(0).max(24).default(0),
    maxCandidatesPerReview: z.number().int().min(0).max(20).default(0),
    maxTokensPerReview: z.number().int().min(0).max(100_000).default(0),
    maxReviewSeconds: z.number().int().min(0).max(3_600).default(0),
    maxRetries: z.number().int().min(0).max(5).default(0),
  })
  .strict()
  .refine(
    (policy) =>
      policy.mode === "off" ||
      (policy.maxReviewsPerDay > 0 &&
        policy.maxCandidatesPerReview > 0 &&
        policy.maxTokensPerReview > 0 &&
        policy.maxReviewSeconds > 0),
    "Enabled learning requires positive review, candidate, token and time limits",
  );

export const BotRuntimeInitiativePolicy = z
  .object({
    enabled: z.boolean().default(false),
    maxRunsPerDay: z.number().int().min(0).max(24).default(0),
    maxTokensPerRun: z.number().int().min(0).max(100_000).default(0),
    maxRunSeconds: z.number().int().min(0).max(3_600).default(0),
    maxRetries: z.number().int().min(0).max(5).default(0),
    maxConcurrentRuns: z.number().int().min(0).max(4).default(0),
    maxMessagesPerDay: z.number().int().min(0).max(24).default(0),
  })
  .strict()
  .refine(
    (policy) =>
      !policy.enabled ||
      (policy.maxRunsPerDay > 0 &&
        policy.maxTokensPerRun > 0 &&
        policy.maxRunSeconds > 0 &&
        policy.maxConcurrentRuns > 0),
    "Enabled initiative requires positive run, token, time and concurrency limits",
  );

export const BotRuntimeRouteReference = z
  .object({
    label: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    modelRef: Identifier,
    effort: z.enum(["low", "medium", "high", "max"]),
    execution: z.enum(["inline", "background", "specialist"]),
  })
  .strict();

export const BotRuntimeRoutingPolicy = z
  .object({
    enabled: z.boolean().default(false),
    routes: z.array(BotRuntimeRouteReference).max(32).default([]),
  })
  .strict()
  .refine(
    (policy) => !policy.enabled || policy.routes.length > 0,
    "Enabled routing requires at least one route",
  )
  .refine(
    (policy) => new Set(policy.routes.map((route) => route.label)).size === policy.routes.length,
    "Route labels must be unique",
  );

/** Initial shared contract only. Runtime enforcement and persistence belong to later slices. */
export const BotRuntimeProfile = z
  .object({
    schemaVersion: z.literal(1).default(1),
    persona: BotRuntimePersona.default({ persona: "" }),
    skills: BotRuntimeSkillSelection.default({ mode: "legacy-library" }),
    extensions: z.array(BotRuntimeExtensionReference).max(32).default([]),
    learning: BotRuntimeLearningPolicy.prefault({}),
    initiative: BotRuntimeInitiativePolicy.prefault({}),
    routing: BotRuntimeRoutingPolicy.prefault({}),
  })
  .strict();
export type BotRuntimeProfile = z.infer<typeof BotRuntimeProfile>;
