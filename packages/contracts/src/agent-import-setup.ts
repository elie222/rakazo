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
]);
export type AgentImportNeed = z.infer<typeof AgentImportNeedSchema>;

/** Whether an imported item works here as is, needs setting up, or cannot work at all. */
export const AgentImportStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("needs_setup"), needs: z.array(AgentImportNeedSchema).min(1) }),
  z.object({
    kind: z.literal("unsupported"),
    reason: z.enum(["unsupported_command", "not_in_catalog", "other_platform"]),
  }),
]);
export type AgentImportStatus = z.infer<typeof AgentImportStatusSchema>;

/** One line of the setup checklist an import posts in the bot's chat. */
export const AgentImportSetupItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model"), title: z.string(), provider: z.string() }),
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
