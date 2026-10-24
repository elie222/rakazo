import * as z from "zod";

/** One concrete thing to set up before an imported item works here. */
export const AgentImportNeedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("api_key"), provider: z.string() }),
  /** Header names the server sends credentials in. */
  z.object({ kind: z.literal("credentials"), names: z.array(z.string()) }),
  z.object({ kind: z.literal("env"), names: z.array(z.string()) }),
  /** A program a stdio server runs on the bot's computer. */
  z.object({ kind: z.literal("program"), name: z.string() }),
  z.object({ kind: z.literal("local_paths") }),
  /** Programs, variables or tools a skill declares it needs. */
  z.object({ kind: z.literal("requires"), names: z.array(z.string()) }),
  /** Imported routines start paused. */
  z.object({ kind: z.literal("turn_on") }),
  /** A skill refers to files next to its SKILL.md, which are not imported. */
  z.object({ kind: z.literal("bundled_files") }),
]);
export type AgentImportNeed = z.infer<typeof AgentImportNeedSchema>;

/** Whether an imported item works here as is, needs setting up, or cannot work at all. */
export const AgentImportStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("needs_setup"), needs: z.array(AgentImportNeedSchema).min(1) }),
  /** Works here, but the user should read it first (a skill with code to run). */
  z.object({ kind: z.literal("needs_review"), reason: z.literal("runs_code") }),
  z.object({
    kind: z.literal("unsupported"),
    reason: z.enum(["unsupported_command", "not_in_catalog", "other_platform"]),
  }),
]);
export type AgentImportStatus = z.infer<typeof AgentImportStatusSchema>;

/** Which items of an import's setup checklist are done now, read when the card is shown. */
export const AgentImportSetupStateInput = z.strictObject({
  botId: z.string().min(1).max(100),
  providers: z.array(z.string().max(100)).max(50),
  serverIds: z.array(z.string().max(100)).max(200),
  routineIds: z.array(z.string().max(100)).max(200),
});
export const AgentImportSetupStateSchema = z.object({
  /** A model credential is connected for the provider. */
  providers: z.record(z.string(), z.boolean()),
  /**
   * The server is given to this bot and has every value it needs; `unverifiable` when it
   * also needs a program or local paths, which cannot be checked from here.
   */
  serverIds: z.record(z.string(), z.union([z.boolean(), z.literal("unverifiable")])),
  /** The routine is turned on. */
  routineIds: z.record(z.string(), z.boolean()),
});
export type AgentImportSetupState = z.infer<typeof AgentImportSetupStateSchema>;

/** One line of the setup checklist an import posts in the bot's chat. */
export const AgentImportSetupItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("model"),
    title: z.string(),
    provider: z.string(),
    /** The provider as model settings name it, e.g. "DeepSeek". */
    providerName: z.string().optional(),
  }),
  z.object({
    kind: z.literal("mcp"),
    serverId: z.string(),
    name: z.string(),
    needs: z.array(AgentImportNeedSchema),
  }),
  z.object({ kind: z.literal("routine"), routineId: z.string(), name: z.string() }),
  z.object({ kind: z.literal("skill"), name: z.string(), needs: z.array(AgentImportNeedSchema) }),
]);
export type AgentImportSetupItem = z.infer<typeof AgentImportSetupItemSchema>;

/**
 * Why an import or its Undo was refused, sent as `data.reason` with the error so clients show
 * their own words for it (the message stays English, for logs and other clients).
 */
export const AGENT_IMPORT_ERROR_REASONS = [
  "selection_mismatch",
  "cannot_run_here",
  "model_needs_key",
  "instructions_too_long",
  "import_reused",
  "first_bot_new_only",
  "name_required",
  "first_bot_exists",
  "instructions_changed",
  "name_just_taken",
  "not_imported",
  "import_changed",
  "key_rejected",
  "key_unverified",
  "key_check_failed",
] as const;
export type AgentImportErrorReason = (typeof AGENT_IMPORT_ERROR_REASONS)[number];

/** The reason an import RPC error carries, if any. */
export function agentImportErrorReason(error: unknown): AgentImportErrorReason | undefined {
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined;
  const reason = data && typeof data === "object" && "reason" in data ? data.reason : undefined;
  return (AGENT_IMPORT_ERROR_REASONS as readonly unknown[]).includes(reason)
    ? (reason as AgentImportErrorReason)
    : undefined;
}
