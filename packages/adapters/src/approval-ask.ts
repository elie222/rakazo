import type { MessageBlock } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { instructionUpdateDiff, redactSecrets, toolRequiresExplicitApproval } from "@rakazo/core";

export const MAX_APPROVAL_SUMMARY_LENGTH = 500;
export const MAX_APPROVAL_DETAIL_LENGTH = 4_000;

/** A fleet card built from the resolved request: a title and the lines under it. */
export type FleetCardSummary = { title: string; lines: string[] };

/**
 * The instruction card shows the whole new text, like `propose_instructions_update`, so its detail
 * holds the longest instructions plus the two length lines above them.
 */
export function approvalDetailLength(toolName: string): number {
  return toolName === "set_child_instructions"
    ? BOT_INSTRUCTIONS_MAX_LENGTH + MAX_APPROVAL_SUMMARY_LENGTH
    : MAX_APPROVAL_DETAIL_LENGTH;
}

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: { reviewReason?: string; summary?: FleetCardSummary },
): MessageBlock {
  if (options?.summary) {
    // Built from what was resolved before the effect was recorded, not from what the model typed.
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: truncate(redactSecrets(options.summary.title, secrets), MAX_APPROVAL_SUMMARY_LENGTH),
      detail: truncate(
        redactSecrets(options.summary.lines.join("\n"), secrets),
        approvalDetailLength(toolName),
      ),
      detailFormat: toolName === "set_child_instructions" ? "code" : "text",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    };
  }
  if (toolName === "propose_instructions_update") {
    const before = redactSecrets(String(args.previousInstructions ?? ""), secrets);
    const after = redactSecrets(String(args.instructions ?? ""), secrets);
    const reason = redactSecrets(String(args.reason), secrets);
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: "Update instructions?",
      detail: instructionUpdateDiff(before, after, reason),
      instructionUpdate: {
        botId: String(args.botId ?? ""),
        before,
        after,
        reason,
      },
      detailFormat: "code",
      status: "pending",
      actions: [
        { id: "allow", label: "Apply" },
        { id: "deny", label: "Dismiss" },
      ],
    };
  }
  const summary = describeApprovalAction(toolName, args);
  const detail = formatApprovalDetail(toolName, args, options?.reviewReason);
  const safeDetail = detail ? redactSecrets(detail, secrets) : undefined;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: truncate(
      redactSecrets(
        toolName === "create_space" ? `${summary}?` : `Review before ${summary}`,
        secrets,
      ),
      MAX_APPROVAL_SUMMARY_LENGTH,
    ),
    detail: safeDetail ? truncate(safeDetail, MAX_APPROVAL_DETAIL_LENGTH) : undefined,
    status: "pending",
    actions:
      toolName === "create_space"
        ? [
            { id: "allow", label: "Create space", outcome: "created" },
            { id: "deny", label: "Cancel", outcome: "cancelled" },
          ]
        : toolRequiresExplicitApproval(toolName)
          ? [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ]
          : [
              { id: "allow", label: "Allow once" },
              { id: "always", label: "Always allow this tool" },
              { id: "deny", label: "Deny" },
            ],
  };
}

function describeApprovalAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "destination.write") {
    const collection = args.collection ? String(args.collection) : "records";
    const title = args.title ? ` "${String(args.title)}"` : "";
    return `writing${title} to ${collection}`;
  }
  if (toolName === "delete_bot" || toolName === "archive_bot") {
    const name = args.confirm_name ?? args.confirmName;
    return name ? `${toolName.replace("_", " ")} (${String(name)})` : toolName.replace("_", " ");
  }
  if (toolName === "create_space") {
    const name = args.name ? String(args.name) : "Untitled";
    return `Create space “${name}”`;
  }
  const target = pickScopeLabel(args);
  return target ? `${toolName} → ${target}` : toolName;
}

function formatApprovalDetail(
  toolName: string,
  args: Record<string, unknown>,
  reviewReason?: string,
): string | undefined {
  const lines: string[] = [];
  if (reviewReason?.trim()) {
    lines.push(reviewReason.trim().replace(/\u2014|\u2013/g, "-"));
  }
  if (toolName === "create_space") {
    lines.push(
      "Bots, groups, chats, files, memory, and integrations in this space stay separate from other spaces.",
    );
  }
  for (const key of ["collection", "title", "to", "subject", "amount", "body"]) {
    const value = args[key];
    if (value == null || value === "") continue;
    lines.push(`${key}: ${String(value)}`);
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

function pickScopeLabel(args: Record<string, unknown>): string | undefined {
  for (const key of ["to", "title", "collection", "subject", "amount"]) {
    const value = args[key];
    if (value != null && value !== "") return String(value);
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
