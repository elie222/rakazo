import type { AttentionAction, AttentionItem, MessageBlock } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock } from "./action-approval.js";

export type AttentionBlockKind = "question" | "approval" | "secret";

/**
 * What a pending card is asking for. Approval wins over a secret, and a card with answer
 * choices is a question even when it carries detail the user is deciding about.
 */
export function attentionKindForBlock(block: MessageBlock): AttentionBlockKind | null {
  if (block.kind === "choice") return block.answerId ? null : "question";
  if (block.kind !== "ask" || block.status === "answered" || block.dismissed) return null;
  if (isApprovalAskBlock(block)) return "approval";
  if (isSecretAskBlock(block)) return "secret";
  return "question";
}

function actionTone(id: string): AttentionAction["tone"] {
  if (id === "deny") return "danger";
  if (id === "allow" || id === "choice-1") return "primary";
  return "secondary";
}

/** Inline answers the inbox can send through `threads.answer`. Secret cards have none. */
export function attentionActionsForBlock(block: MessageBlock): AttentionAction[] {
  if (block.kind === "choice") {
    if (block.answerId) return [];
    return block.options.map((option) => ({
      id: option.id,
      label: option.label,
      answer: option.id,
      // A question's choices are equally valid; none is the app's recommendation.
      tone: "secondary" as const,
    }));
  }
  if (block.kind !== "ask" || block.status === "answered" || block.dismissed) return [];
  if (isSecretAskBlock(block)) return [];
  const approval = isApprovalAskBlock(block);
  return (block.actions ?? []).map((action) => ({
    id: action.id,
    label: action.label,
    answer: action.id,
    // Only an approval has a recommended answer; a question's choices are equal.
    tone: approval ? actionTone(action.id) : ("secondary" as const),
  }));
}

const KIND_RANK: Record<AttentionItem["kind"], number> = {
  takeover: 0,
  question: 1,
  approval: 1,
  secret: 1,
  failed: 2,
  routine_delayed: 3,
};

/** Takeovers first, then open cards, then failures, then behind schedules; oldest first within a kind. */
export function sortAttentionItems<T extends Pick<AttentionItem, "kind" | "createdAt">>(
  items: readonly T[],
): T[] {
  return [...items].sort((left, right) => {
    const byKind = KIND_RANK[left.kind] - KIND_RANK[right.kind];
    if (byKind !== 0) return byKind;
    const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return byTime !== 0 ? byTime : 0;
  });
}
