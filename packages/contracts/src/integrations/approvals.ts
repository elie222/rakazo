import * as z from "zod";
import { Id } from "../ids.js";

export const ActionApprovalRuleSchema = z.object({
  id: Id,
  effect: z.enum(["always_allow", "require_approval", "deny"]),
  matchKind: z.enum(["tool", "connector", "category", "site", "connection_tool"]),
  matchValue: z.string(),
  createdAt: z.string(),
});
export type ActionApprovalRule = z.infer<typeof ActionApprovalRuleSchema>;

export const ALWAYS_ALLOW_BATCH_LABEL = "Always allow these tools";

export const ConnectionToolPath = z
  .string()
  .min(1)
  .max(512)
  .refine((path) => !/[\p{Cc}\p{Cf}]/u.test(path));
const ConnectionToolId = Id.max(128);
const ConnectionToolName = z.string().min(1).max(160);
const ConnectionToolRuleValue = z.tuple([ConnectionToolId, ConnectionToolPath, ConnectionToolName]);
const CONNECTION_TOOL_PREFIX = "connection-tool:";

export function connectionToolRuleValue(
  connectionId: string,
  path: string,
  connectionName: string,
): string {
  return CONNECTION_TOOL_PREFIX + JSON.stringify([connectionId, path, connectionName]);
}

export function parseConnectionToolRuleValue(value: string) {
  if (!value.startsWith(CONNECTION_TOOL_PREFIX)) return undefined;
  try {
    const result = ConnectionToolRuleValue.safeParse(
      JSON.parse(value.slice(CONNECTION_TOOL_PREFIX.length)),
    );
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** A stored effect distinguishes verified connection actions from free-form batch names. */
export const ScopedBatchAction = z.object({
  connectionId: ConnectionToolId,
  path: ConnectionToolPath,
  connectionName: ConnectionToolName,
});
export type ScopedBatchAction = z.infer<typeof ScopedBatchAction>;

/** How much a space asks before acting; see VISION.md. */
export const ApprovalModeSchema = z.enum(["never", "auto", "ask"]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const ActionAutoReviewSettingsSchema = z.object({
  mode: ApprovalModeSchema,
  /** The stored form of `mode`, kept for clients that predate it. */
  enabled: z.boolean(),
  checkerAvailable: z.boolean(),
  skipApprovals: z.boolean(),
});
export type ActionAutoReviewSettings = z.infer<typeof ActionAutoReviewSettingsSchema>;
