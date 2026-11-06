import { isApprovalAskBlock, isSecretAskBlock } from "./action-approval.js";

type AskSnapshot = {
  messages: readonly {
    id: string;
    runId?: string | null;
    blocks: readonly { kind: string; status?: string; input?: string; approvalEffectId?: string }[];
  }[];
  run?: { id: string; status: string; userId?: string } | null;
  activeRuns?: readonly { id: string; status: string; userId?: string }[];
};

export function answerableAskMessageIds(snapshot: AskSnapshot | null): Set<string> {
  const answerable = new Set<string>();
  if (!snapshot) return answerable;
  const waitingRunIds = new Set(
    (snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []))
      .filter((run) => run.status === "waiting_input")
      .map((run) => run.id),
  );
  for (const message of snapshot.messages) {
    if (!message.runId || !waitingRunIds.has(message.runId)) continue;
    if (message.blocks.some((block) => block.kind === "ask" && block.status !== "answered")) {
      answerable.add(message.id);
    }
  }
  return answerable;
}

/** Secret requests can only be dismissed by the user of their run. */
export function dismissableAskMessageIds(
  snapshot: AskSnapshot | null,
  userId?: string,
): Set<string> {
  const dismissable = new Set<string>();
  if (!snapshot || !userId) return dismissable;
  const runs = snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []);
  const ownedRunIds = new Set(
    runs
      .filter((run) => run.status === "waiting_input" && run.userId === userId)
      .map((run) => run.id),
  );
  for (const message of snapshot.messages) {
    if (
      message.runId &&
      ownedRunIds.has(message.runId) &&
      message.blocks.some((block) => isSecretAskBlock(block) && block.status !== "answered")
    ) {
      dismissable.add(message.id);
    }
  }
  return dismissable;
}

export function selectedAskActionLabel(
  answer: string,
  actions?: readonly { id: string; label: string }[],
): string {
  return resolveAskChoice(answer, actions)?.label ?? answer;
}

export function resolveAskChoice(
  answer: string,
  actions?: readonly { id: string; label: string }[],
): { id: string; label: string } | undefined {
  if (!actions?.length) return undefined;
  const trimmed = answer.trim();
  if (!trimmed) return undefined;
  const byId = actions.find((action) => action.id === trimmed);
  if (byId) return byId;
  const lower = trimmed.toLowerCase();
  return actions.find((action) => action.label.trim().toLowerCase() === lower);
}

/** A question a typed reply can answer: approvals and secret requests need their card. */
export function isTextAnswerableAsk(block: {
  kind: string;
  input?: string;
  approvalEffectId?: string;
  actions?: Array<{ id: string; label: string }>;
}): boolean {
  return block.kind === "ask" && !isApprovalAskBlock(block) && !isSecretAskBlock(block);
}

/** A question as plain text for chats without cards, its options numbered so a reply can pick one. */
export function askAsPlainText(block: {
  text: string;
  detail?: string;
  actions?: readonly { id: string; label: string }[];
}): string {
  const options = (block.actions ?? []).map((action, index) => `${index + 1}. ${action.label}`);
  return [block.text.trim(), block.detail?.trim(), options.join("\n")].filter(Boolean).join("\n\n");
}

/**
 * The answer a plain-text reply gives a question sent by askAsPlainText: a number within the list,
 * also written "2.", "2)", "2、" or "#2", picks the option listed under it, even when an option's
 * label is a number. Anything else, an out-of-range number included, is passed on as written, so
 * the usual label matching applies.
 */
export function plainTextAskAnswer(
  reply: string,
  actions?: readonly { id: string; label: string }[],
): string {
  const trimmed = reply.trim();
  const number = /^#?\s*(\d+)\s*[.)、]?$/.exec(trimmed)?.[1];
  if (!number) return trimmed;
  return actions?.[Number(number) - 1]?.id ?? trimmed;
}
