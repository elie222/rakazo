import type { AttentionAction, AttentionItem, MessageBlock } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock } from "./action-approval.js";

export type AttentionBlockKind = "question" | "approval" | "secret";

/**
 * What a pending ask is asking for. Approval wins over a secret. Choice cards belong to
 * onboarding and are answered by that flow, not by `threads.answer`.
 */
export function attentionKindForBlock(block: MessageBlock): AttentionBlockKind | null {
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

export type AttentionSectionKey = "waiting" | "failed" | "routines";

const SECTION_BY_KIND: Record<AttentionItem["kind"], AttentionSectionKey> = {
  takeover: "waiting",
  question: "waiting",
  approval: "waiting",
  secret: "waiting",
  failed: "failed",
  routine_delayed: "routines",
};

/** The section an item belongs to in the inbox. */
export function attentionSectionKey(kind: AttentionItem["kind"]): AttentionSectionKey {
  return SECTION_BY_KIND[kind];
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
