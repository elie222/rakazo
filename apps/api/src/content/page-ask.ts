import type { CodexLiveCatalog } from "@rakazo/adapters";
import { readPublicTask } from "@rakazo/adapters";
import type { Actor, PageAskEvent, PageAskInput, PublicTask } from "@rakazo/contracts";
import { AI_CONSENT_REQUIRED, PAGE_ANSWER_MAX_LENGTH, taskSettled } from "@rakazo/contracts";
import { ClientError, deadlineSignal, pageReply } from "@rakazo/core";
import { IsolationError } from "@rakazo/db";
import { aiConsentStatus } from "../account/ai-consent.js";
import { taskAnswer } from "../bot-access/openai-compat.js";
import type { RouterDeps } from "../router.js";
import { HEARTBEAT, withHeartbeats } from "../routes/shared.js";
import { ownSentTask, sendAsUser, TASK_EVENTS } from "../threads/thread-send.js";
import { resolveThreadTarget, threadHead } from "../threads/thread-target.js";

/** How long a page waits for its answer; a later reply still lands in the chat. */
const PAGE_ASK_WAIT_MS = 10 * 60_000;

export class PageAskNotAllowedError extends ClientError {
  constructor() {
    super("FORBIDDEN", "This page can't ask its bot.", "PAGE_ASK_NOT_ALLOWED");
  }
}

/**
 * A page's question to its bot: sent into the page's chat as its owner, naming the page, then
 * followed on the chat's live events until the bot's turn settles. `working` repeats while it
 * runs; the last event is the answer or why there is none.
 */
export async function* askFromPage(
  deps: RouterDeps & { codexCatalog?: CodexLiveCatalog },
  actor: Actor,
  input: PageAskInput & { pageId: string },
  signal?: AbortSignal,
): AsyncGenerator<PageAskEvent> {
  const page = await deps.prisma.page.findFirst({
    where: { id: input.pageId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, title: true, botId: true, groupId: true, currentVersion: true },
  });
  if (!page) throw new IsolationError();
  const version = await deps.prisma.pageVersion.findUnique({
    where: { pageId_version: { pageId: page.id, version: page.currentVersion } },
    select: { abilities: true },
  });
  const chat = page.groupId ? { groupId: page.groupId } : page.botId ? { botId: page.botId } : null;
  if (!chat || !version?.abilities.includes("ask")) throw new PageAskNotAllowedError();
  const consent = await aiConsentStatus(deps, actor, { ...chat, uses: ["model", "memory"] });
  if (consent.recipients.some((recipient) => !recipient.allowed))
    throw new ClientError("FORBIDDEN", AI_CONSENT_REQUIRED, "AI_CONSENT_REQUIRED");

  const target = await resolveThreadTarget(deps.prisma, actor, chat);
  // Read before sending, so the follow sees every event the turn writes.
  const { cursor } = await threadHead(deps.prisma, target);
  const clientNonce = `page-ask:${input.clientNonce}`;
  const sent = await sendAsUser(deps, actor, {
    ...chat,
    text: pageReply(input.text, [], page).text,
    clientNonce,
  });
  yield { kind: "working" };
  const own = await ownSentTask(deps.prisma, actor, {
    threadId: target.threadId,
    clientNonce,
    taskId: sent.taskId,
  });
  if (!own) {
    yield { kind: "failed", message: "The bot is busy with someone else's request." };
    return;
  }
  const owner = { taskId: own.taskId, userId: actor.userId, spaceId: actor.spaceId };
  // What the task said before this question, when the question joined a turn already going.
  const earlierOutput =
    own.seq === undefined
      ? ""
      : ((await readPublicTask(deps.prisma, owner, own.seq))?.output ?? "");
  let task = await readPublicTask(deps.prisma, owner);
  const wait = deadlineSignal(PAGE_ASK_WAIT_MS, signal);
  try {
    if (task && !taskSettled(task.status)) {
      const events = withHeartbeats(
        { signal: wait },
        (follow) => deps.events.follow(target.threadId, cursor, follow),
        (event) => TASK_EVENTS.has(event.type),
      );
      for await (const event of events) {
        if (event === HEARTBEAT) {
          yield { kind: "working" };
          continue;
        }
        task = await readPublicTask(deps.prisma, owner);
        if (!task || taskSettled(task.status)) break;
      }
    }
  } catch (error) {
    if (!wait.aborted) throw error;
  }
  if (signal?.aborted) return;
  yield pageAskOutcome(task, earlierOutput);
}

function pageAskOutcome(task: PublicTask | null, earlierOutput: string): PageAskEvent {
  if (!task || !taskSettled(task.status))
    return { kind: "failed", message: "The bot is still working. Its answer will be in the chat." };
  if (task.status === "failed" || task.status === "cancelled")
    return { kind: "failed", message: "The bot couldn't answer." };
  const text = taskAnswer(task, earlierOutput).trim();
  return text
    ? { kind: "answer", text: text.slice(0, PAGE_ANSWER_MAX_LENGTH) }
    : { kind: "failed", message: "The bot didn't reply." };
}
