import * as z from "zod";

export const Id = z.string().min(1);
export const IsoDate = z.string().datetime({ offset: true });

export const ActorSchema = z.object({
  userId: Id,
  spaceId: Id,
  email: z.string().email(),
  /** Deprecated wire field. App accounts have no deployment role; always false. */
  isDeploymentOwner: z.boolean(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const RunStatus = z.enum([
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** How a bot talks to people while it works: its written text, or only the messages it sends. */
export const ReplyModeSchema = z.enum(["chat", "messages"]);
export type ReplyMode = z.infer<typeof ReplyModeSchema>;

export const MemoryScope = z.enum(["bot", "user"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

/**
 * A computer provider's id. Opaque here: the adapters own the list of providers and check an id
 * against it, so a stored kind this build no longer has still reads.
 */
export const SandboxKind = z.string().min(1);
export type SandboxKind = z.infer<typeof SandboxKind>;
