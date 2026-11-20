import type { resolveActionApprovalForTools } from "@rakazo/core";
import { decisiveActionApprovalRules, humanizeToolName } from "@rakazo/core";
import type { AuditEventInput } from "@rakazo/db";
import { recordAuditEvent } from "@rakazo/db";
import type { RunContext } from "../assembly/run-context.js";

/** A bot's consequential tool call, recorded in its organization's audit log. */
export async function auditToolCall(
  ctx: RunContext,
  tool: string,
  outcome: "success" | "failure" | "denied",
  metadata: AuditEventInput["metadata"],
  recorded: Pick<AuditEventInput, "action" | "actor"> = {
    action: "tool.call",
    actor: { type: "bot", id: ctx.bot.id, label: ctx.bot.name },
  },
): Promise<void> {
  await recordAuditEvent({
    ...recorded,
    spaceId: ctx.run.spaceId,
    target: { type: "tool", id: tool, label: humanizeToolName(tool) },
    outcome,
    runId: ctx.runId,
    threadId: ctx.thread.id,
    metadata,
  });
}
/** Names the saved rules a refusal cites, as a suffix on its message. */
export function blockingRuleSuffix(
  resolved: ReturnType<typeof resolveActionApprovalForTools>,
): string {
  const labels = decisiveActionApprovalRules(resolved).map((rule) => {
    const value = rule.matchValue.trim().replace(/\s+/g, " ");
    return JSON.stringify(rule.matchKind === "site" ? value : humanizeToolName(value));
  });
  if (labels.length === 0) return "";
  return ` by the saved ${labels.length === 1 ? "rule" : "rules"} ${labels.join(", ")}`;
}
