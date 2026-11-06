import { isSecretAskBlock } from "./action-approval.js";

type AskSnapshot = {
  messages: readonly {
    id: string;
    runId?: string | null;
    author?: { id: string; name: string } | null;
    blocks: readonly { kind: string; status?: string; input?: string; approvalEffectId?: string }[];
  }[];
  run?: { id: string; status: string; userId?: string } | null;
  activeRuns?: readonly { id: string; status: string; userId?: string }[];
};

/** Who another person's pending card waits on; the name only when the snapshot has it. */
export type AskWaitingOn = { userId: string; name?: string };

function waitingRuns(snapshot: AskSnapshot) {
  return (snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : [])).filter(
    (run) => run.status === "waiting_input",
  );
}

/** In a shared space only the person whose run asked answers its card; unknown users can. */
function isOthersRun(run: { userId?: string }, userId?: string): boolean {
  return Boolean(run.userId && userId && run.userId !== userId);
}

function hasPendingAsk(message: AskSnapshot["messages"][number]) {
  return message.blocks.some((block) => block.kind === "ask" && block.status !== "answered");
}

export function answerableAskMessageIds(
  snapshot: AskSnapshot | null,
  userId?: string,
): Set<string> {
  const answerable = new Set<string>();
  if (!snapshot) return answerable;
  const waitingRunIds = new Set(
    waitingRuns(snapshot)
      .filter((run) => !isOthersRun(run, userId))
      .map((run) => run.id),
  );
  for (const message of snapshot.messages) {
    if (!message.runId || !waitingRunIds.has(message.runId)) continue;
    if (hasPendingAsk(message)) answerable.add(message.id);
  }
  return answerable;
}

/** Pending cards of another person's waiting run, by message, with who they wait on. */
export function waitingOnAskMessages(
  snapshot: AskSnapshot | null,
  userId?: string,
): Map<string, AskWaitingOn> {
  const waitingOn = new Map<string, AskWaitingOn>();
  if (!snapshot) return waitingOn;
  const othersRunUserIds = new Map<string, string>();
  for (const run of waitingRuns(snapshot)) {
    if (run.userId && isOthersRun(run, userId)) othersRunUserIds.set(run.id, run.userId);
  }
  if (!othersRunUserIds.size) return waitingOn;
  const names = new Map<string, string>();
  for (const message of snapshot.messages) {
    const name = message.author?.name.trim();
    if (message.author && name) names.set(message.author.id, name);
  }
  for (const message of snapshot.messages) {
    const runUserId = message.runId ? othersRunUserIds.get(message.runId) : undefined;
    if (!runUserId || !hasPendingAsk(message)) continue;
    const name = names.get(runUserId);
    waitingOn.set(message.id, name ? { userId: runUserId, name } : { userId: runUserId });
  }
  return waitingOn;
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
