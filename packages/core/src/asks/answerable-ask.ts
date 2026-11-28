import { AGENT_IMPORT_ASK_ACTION_ID } from "@rakazo/contracts";
import { isSecretAskBlock } from "../runs/action-approval.js";

type AskSnapshot = {
  messages: readonly {
    id: string;
    runId?: string | null;
    blocks: readonly { kind: string; status?: string; input?: string; approvalEffectId?: string }[];
  }[];
  run?: { id: string; status: string; userId?: string } | null;
  activeRuns?: readonly { id: string; status: string; userId?: string }[];
};

export function answerableAskMessageIds(
  snapshot: AskSnapshot | null,
  userId?: string,
): Set<string> {
  const answerable = new Set<string>();
  if (!snapshot) return answerable;
  const ownRuns = (snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : [])).filter(
    (run) => !userId || run.userId === userId,
  );
  const runIds = (status: string) =>
    new Set(ownRuns.filter((run) => run.status === status).map((run) => run.id));
  const waitingRunIds = runIds("waiting_input");
  // A tool's question is answered while its run is still running: the call waits on it.
  const runningRunIds = runIds("running");
  for (const message of snapshot.messages) {
    if (!message.runId) continue;
    const pending = (kind: string, open: (status?: string) => boolean) =>
      message.blocks.some((block) => block.kind === kind && open(block.status));
    if (
      (waitingRunIds.has(message.runId) && pending("ask", (status) => status !== "answered")) ||
      (runningRunIds.has(message.runId) &&
        pending("tool_question", (status) => status === "pending"))
    ) {
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
  return (
    (resolveAskChoice(answer, actions) ?? legacyImportAction(answer, actions))?.label ?? answer
  );
}

/**
 * Whether a user reply's text is a card's stored answer. A card answered before the import
 * action stopped counting as a choice stored that action's id while its reply holds the label.
 */
export function askAnswerRepliedWith(
  answer: string,
  actions: readonly { id: string; label: string }[] | undefined,
  replyText: string,
): boolean {
  const text = replyText.trim();
  if (!text) return false;
  if (answer.trim() === text) return true;
  return legacyImportAction(answer, actions)?.label.trim().toLowerCase() === text.toLowerCase();
}

function legacyImportAction(answer: string, actions?: readonly { id: string; label: string }[]) {
  if (answer.trim() !== AGENT_IMPORT_ASK_ACTION_ID) return undefined;
  return actions?.find((action) => action.id === AGENT_IMPORT_ASK_ACTION_ID);
}

export function resolveAskChoice(
  answer: string,
  actions?: readonly { id: string; label: string }[],
): { id: string; label: string } | undefined {
  if (!actions?.length) return undefined;
  const trimmed = answer.trim();
  if (!trimmed) return undefined;
  // Client-only UI actions (such as opening the agent importer) are never bot answer choices.
  const choices = actions.filter((action) => action.id !== AGENT_IMPORT_ASK_ACTION_ID);
  const byId = choices.find((action) => action.id === trimmed);
  if (byId) return byId;
  const lower = trimmed.toLowerCase();
  return choices.find((action) => action.label.trim().toLowerCase() === lower);
}
