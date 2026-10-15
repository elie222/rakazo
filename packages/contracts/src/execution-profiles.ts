import * as z from "zod";
import { Id } from "./ids.js";

export const ExecutionHarnessSchema = z.enum(["pi", "claude", "codex", "kimi"]);
export const ExecutionProtocolSchema = z.enum([
  "anthropic",
  "openai-responses",
  "openai-chat-completions",
]);
export const ExecutionAuthSchemeSchema = z.enum(["api-key", "bearer"]);
const RoleModelId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      [...value].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    "Model IDs cannot contain control characters",
  );
export const ExecutionModelRolesSchema = z
  .object({
    haiku: RoleModelId.optional(),
    sonnet: RoleModelId.optional(),
    opus: RoleModelId.optional(),
    fable: RoleModelId.optional(),
    subagent: RoleModelId.optional(),
  })
  .strict();
export type ExecutionModelRoles = z.infer<typeof ExecutionModelRolesSchema>;

export const NATIVE_EXECUTION_CAPABILITIES = {
  delegatedAgents: true,
  requiresRestrictedLinuxDocker: true,
} as const;

export const EXECUTION_HARNESS_VERSIONS = {
  pi: "0.87.1",
  claude: "0.3.300",
  codex: "0.162.1",
  kimi: "2.2.0",
} as const;

export const ExecutionInputModalitySchema = z.enum(["image", "audio"]);
export type ExecutionInputModality = z.infer<typeof ExecutionInputModalitySchema>;
export const ExecutionInputModalitiesSchema = z
  .array(ExecutionInputModalitySchema)
  .max(2)
  .refine((values) => new Set(values).size === values.length, "Choose each input type once.")
  .default([]);

type ExecutionMediaConfiguration = {
  harness: z.infer<typeof ExecutionHarnessSchema>;
  protocol: z.infer<typeof ExecutionProtocolSchema>;
  runtimeVersion: string;
  endpoint: string | null;
};

/** Transport support is only an upper bound; a profile must also declare model support. */
export function supportedExecutionInputModalities(
  profile: ExecutionMediaConfiguration,
): ExecutionInputModality[] {
  const protocols: readonly string[] = EXECUTION_HARNESS_PROTOCOLS[profile.harness];
  if (
    profile.runtimeVersion !== EXECUTION_HARNESS_VERSIONS[profile.harness] ||
    !protocols.includes(profile.protocol)
  )
    return [];
  const supported: ExecutionInputModality[] = ["image"];
  // Codex can carry audio through app-server, but OpenAI Responses does not accept it.
  // Only an explicitly configured compatible endpoint can declare native audio support.
  if (profile.harness === "codex" && profile.endpoint) {
    try {
      const url = new URL(profile.endpoint);
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      const official = ["openai.com", "chatgpt.com"].some(
        (domain) => host === domain || host.endsWith(`.${domain}`),
      );
      if (!official && (url.protocol === "https:" || url.protocol === "http:"))
        supported.push("audio");
    } catch {
      // Invalid endpoints never enable audio; the create schema reports the URL error.
    }
  }
  return supported;
}

/** Live-call transcripts are text and are intentionally outside this native-media contract. */
export function executionProfileMediaCapabilities(
  profile: ExecutionMediaConfiguration & { inputModalities?: readonly ExecutionInputModality[] },
): { imageInput: boolean; audioInput: boolean } {
  const supported = supportedExecutionInputModalities(profile);
  return {
    imageInput: supported.includes("image") && Boolean(profile.inputModalities?.includes("image")),
    audioInput: supported.includes("audio") && Boolean(profile.inputModalities?.includes("audio")),
  };
}

export const EXECUTION_HARNESS_LABELS = {
  pi: "Pi",
  claude: "Claude Agent",
  codex: "Codex",
  kimi: "Kimi Code",
} as const;

export const EXECUTION_HARNESS_PROTOCOLS = {
  pi: ["anthropic", "openai-responses", "openai-chat-completions"],
  claude: ["anthropic"],
  codex: ["openai-responses"],
  kimi: ["openai-chat-completions"],
} as const;

// Endpoint configuration is explicit, never inferred from a repository or CLI home.
export const ExecutionEndpointSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "Use an HTTP(S) endpoint without credentials, query parameters, or a fragment.");

const profileConfiguration = {
  name: z.string().trim().min(1).max(80),
  harness: ExecutionHarnessSchema,
  provider: z.string().trim().min(1).max(80),
  credentialId: Id,
  protocol: ExecutionProtocolSchema,
  authScheme: ExecutionAuthSchemeSchema.default("api-key"),
  modelRoles: ExecutionModelRolesSchema.default({}),
  endpoint: ExecutionEndpointSchema.nullable(),
  modelId: z.string().trim().min(1).max(200),
  inputModalities: ExecutionInputModalitiesSchema,
  runtimeVersion: z.string().trim().min(1).max(80),
  computerId: Id.nullable(),
};

export const ExecutionProfileSchema = z.object({
  id: Id,
  seriesId: Id,
  revision: z.number().int().positive(),
  spaceId: Id,
  ...profileConfiguration,
  createdAt: z.string(),
});
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;

export const ExecutionProfileModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  protocol: ExecutionProtocolSchema,
  inputModalities: z.array(ExecutionInputModalitySchema),
});
export type ExecutionProfileModel = z.infer<typeof ExecutionProfileModelSchema>;

export const CreateExecutionProfileInput = z
  .object({
    ...profileConfiguration,
    endpoint: ExecutionEndpointSchema.nullable().default(null),
    computerId: Id.nullable().default(null),
    supersedesId: Id.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.harness !== "claude" &&
      (value.authScheme !== "api-key" || Object.keys(value.modelRoles).length > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["authScheme"],
        message: "Bearer authentication and model role mappings require Claude Agent.",
      });
    }
    if (value.harness !== "pi" && !value.endpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: "Enter an explicit endpoint for this harness.",
      });
    }
    if (value.runtimeVersion !== EXECUTION_HARNESS_VERSIONS[value.harness]) {
      ctx.addIssue({
        code: "custom",
        path: ["runtimeVersion"],
        message: `This harness requires runtime ${EXECUTION_HARNESS_VERSIONS[value.harness]}.`,
      });
    }
    const protocols: readonly string[] = EXECUTION_HARNESS_PROTOCOLS[value.harness];
    if (!protocols.includes(value.protocol)) {
      ctx.addIssue({
        code: "custom",
        path: ["protocol"],
        message: `This harness requires ${protocols.join(" or ")}.`,
      });
    }
    const supported = supportedExecutionInputModalities(value);
    for (const modality of value.inputModalities) {
      if (!supported.includes(modality)) {
        ctx.addIssue({
          code: "custom",
          path: ["inputModalities"],
          message: `This harness and endpoint do not support ${modality} input.`,
        });
      }
    }
  });
export type CreateExecutionProfileInput = z.infer<typeof CreateExecutionProfileInput>;

/** Durable run configuration. References only; it never contains credential material. */
export const ExecutionProfileSnapshotSchema = z.object({
  profileId: Id,
  profileName: z.string().optional(),
  credentialLabel: z.string().optional(),
  revision: z.number().int().positive(),
  spaceId: Id,
  userId: Id,
  harness: ExecutionHarnessSchema,
  provider: z.string().min(1),
  credentialId: Id,
  credentialSecretId: Id,
  protocol: ExecutionProtocolSchema,
  authScheme: ExecutionAuthSchemeSchema.default("api-key"),
  modelRoles: ExecutionModelRolesSchema.default({}),
  endpoint: ExecutionEndpointSchema.nullable(),
  modelId: z.string().min(1),
  inputModalities: ExecutionInputModalitiesSchema,
  runtimeVersion: z.string().min(1),
  computerId: Id.nullable(),
});
export type ExecutionProfileSnapshot = z.infer<typeof ExecutionProfileSnapshotSchema>;

export const RunExecutionProfileSchema = z.object({
  id: Id,
  name: z.string(),
  revision: z.number().int().positive(),
  harness: ExecutionHarnessSchema,
  provider: z.string(),
  modelId: z.string(),
  accountLabel: z.string(),
});
export type RunExecutionProfile = z.infer<typeof RunExecutionProfileSchema>;

/** Public attribution is an allowlist, never the internal run snapshot. */
export function runExecutionProfileSummary(value: unknown): RunExecutionProfile | null {
  const parsed = ExecutionProfileSnapshotSchema.safeParse(value);
  if (!parsed.success) return null;
  const snapshot = parsed.data;
  return {
    id: snapshot.profileId,
    name: snapshot.profileName ?? "Execution profile",
    revision: snapshot.revision,
    harness: snapshot.harness,
    provider: snapshot.provider,
    modelId: snapshot.modelId,
    accountLabel: snapshot.credentialLabel ?? "Connected account",
  };
}
