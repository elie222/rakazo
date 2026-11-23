import { botMessageAllowsSilence, userTurnMessageForRun } from "@rakazo/core";
import { isPartialReplyClientNonce, storedMessageBlocks } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { loadAgentMemoryContext } from "../../memory/memory-context.js";
import { PARTIAL_REPLY_NOTE } from "../../messaging/automated-messages.prompt.js";
import {
  historyWindowSize,
  selectCompactedHistory,
} from "../../runtime/context/history-compaction.js";
import {
  formatRecalledMemory,
  MAX_RECALLED_MEMORIES,
} from "../../runtime/context/history-compaction.prompt.js";
import {
  historySpeaker,
  loadSpacePeople,
  loadThreadSpeakers,
  neutralizeSpeakerLabels,
} from "../../runtime/context/history-speakers.js";
import { loadAgentScratchpadContext } from "../../runtime/context/scratchpad-context.js";
import { loadAgentTicketContext } from "../../tasks/ticket-context.js";
import type { RunHold } from "../lifecycle/run-attempt.js";
import { loadCurrentTurnImages } from "../turn/run-turn-images.js";
import { messageToAgentHistorySegments, messageToAgentHistoryText } from "./reply-context.js";
import type { ConnectedRun, RunRecords } from "./run-assembly-records.js";
import { threadContextForRun } from "./run-instructions.prompt.js";
import { DELEGATED_EMPTY_NOTICE, runAllowsSilentEmpty } from "./run-replies.prompt.js";

export async function readThreadHistory(hold: RunHold, parts: { records: RunRecords }) {
  const { deps, run } = hold;
  const { bot, historyReach, messages, nonOwnerChatRun, replaysToolHistory, thread } =
    parts.records;
  // Group threads and spaces several people share: who wrote each message, so the model can
  // tell the bots and the people apart. A personal space's direct chat stays plain turns.
  const people = await loadSpacePeople(
    deps.prisma,
    thread.space?._count.memberships ?? 0,
    run.userId,
    messages,
  );
  const speakers = await loadThreadSpeakers(
    deps.prisma,
    thread,
    { spaceId: run.spaceId, bot },
    messages,
    people,
  );
  const threadContext = threadContextForRun(
    run.trigger,
    {
      messages: [...messages].reverse().map((m) => {
        const speaker = historySpeaker(speakers, m);
        // In a group, turns from several speakers are joined, so no line may pose as a label.
        const neutral = (value: string) => (speakers ? neutralizeSpeakerLabels(value) : value);
        const text = neutral(messageToAgentHistoryText(m));
        const partial = isPartialReplyClientNonce(m.clientNonce);
        // Runs for someone other than the owner replay replies as everyone saw them.
        const segments =
          m.role === "user" || m.role === "system" || speaker || !replaysToolHistory
            ? undefined
            : messageToAgentHistorySegments(m)?.map((segment) =>
                "text" in segment
                  ? { text: neutral(segment.text) }
                  : {
                      steps: segment.steps.map((step) => ({
                        ...step,
                        ...(step.note ? { note: neutral(step.note) } : {}),
                        ...(step.calls
                          ? {
                              calls: step.calls.map((call) =>
                                call.result ? { ...call, result: neutral(call.result) } : call,
                              ),
                            }
                          : {}),
                      })),
                    },
              );
        return {
          id: m.id,
          createdAt: m.createdAt?.toISOString(),
          seq: m.seq,
          role: (m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant") as
            | "user"
            | "assistant"
            | "system",
          ...(speaker ? { speaker } : {}),
          waiting: m.steeringMessages.length > 0,
          content: partial ? `${text}\n\n${PARTIAL_REPLY_NOTE}` : text,
          ...(segments
            ? { segments: partial ? [...segments, { text: PARTIAL_REPLY_NOTE }] : segments }
            : {}),
        };
      }),
      summary: thread.historyCompactionSummary,
      historyCompactedUpToSeq: thread.historyCompactedUpToSeq,
    },
    nonOwnerChatRun,
    run.sourceMessageId,
    historyReach,
  );
  const compactedHistory = selectCompactedHistory({
    messages: threadContext.messages,
    summary: threadContext.summary,
    historyCompactedUpToSeq: threadContext.historyCompactedUpToSeq,
  });
  return { people, speakers, threadContext, compactedHistory };
}

export type ThreadHistory = Awaited<ReturnType<typeof readThreadHistory>>;

export async function loadTurnContext(
  hold: RunHold,
  parts: { records: RunRecords; connected: ConnectedRun; thread: ThreadHistory },
) {
  const { deps, run, runId } = hold;
  const {
    bot,
    messages,
    messagingChannelRun,
    nonOwnerChatRun,
    ownerComputerRoutine,
    peerMessage,
    task,
    thread,
    ticketBoardEnabled,
  } = parts.records;
  // Memory, the scratchpad and tickets hold text other runs and members wrote, which a routine
  // with its owner's computer never reads.
  const savedContextHidden = nonOwnerChatRun || ownerComputerRoutine;
  const { context, discoveredPromise, memoryScope, semanticMemory } = parts.connected;
  const { compactedHistory, threadContext } = parts.thread;
  let history = compactedHistory.history.map(
    ({ id, role, content, createdAt, speaker, segments }) => ({
      id,
      createdAt,
      role,
      content,
      ...(speaker ? { speaker } : {}),
      ...(segments ? { segments } : {}),
    }),
  );
  const historyMessages = messages
    .filter((message) => message.steeringMessages.length === 0)
    .map((message) => ({
      id: message.id,
      role: message.role,
      runId: message.runId,
      createdAt: message.createdAt,
      blocks: storedMessageBlocks(message),
    }));
  const currentTurnMessage = userTurnMessageForRun(
    run.trigger,
    runId,
    historyMessages,
    run.sourceMessageId,
  );
  const turnBlocks = currentTurnMessage?.blocks;
  // A run owns its source message and steering bound to it, including waiting-input
  // replies. message.runId alone is display linkage: a send during background work
  // points at that run but waits for its continuation. Read independently of history.
  const currentRunImageMessages = await deps.prisma.message.findMany({
    where: {
      threadId: thread.id,
      OR: [
        ...(run.sourceMessageId ? [{ id: run.sourceMessageId }] : []),
        ...(run.trigger === "helper" ? [{ runId }] : []),
        { steeringMessages: { some: { runId, botId: run.botId } } },
      ],
      role: "user",
      blocks: { array_contains: [{ kind: "image" }] },
    },
    select: { id: true, blocks: true },
    orderBy: { seq: "asc" },
  });
  // The content extension decrypts imageHandling after filtering on plain kind.
  const confirmedRunImages = currentRunImageMessages.flatMap((message) =>
    storedMessageBlocks(message).filter(
      (block) => block.kind === "image" && block.imageHandling === "confirm",
    ),
  );
  const currentRunRequiresImageInput = confirmedRunImages.length > 0;
  // The send decided whether the message named this member; one it named nobody for
  // reached every member, and each may end its turn without a reply.
  const groupReplyOptional =
    Boolean(parts.records.conversationThread.groupId) &&
    run.trigger === "user" &&
    run.groupReplyOptional;
  const allowSilentPeerMessage = botMessageAllowsSilence(
    peerMessage?.intent,
    peerMessage?.repliesToRequest,
  );
  const allowSilentEmptyRun =
    allowSilentPeerMessage ||
    messagingChannelRun ||
    runAllowsSilentEmpty(run.trigger) ||
    (Boolean(parts.records.conversationThread.groupId) && run.trigger === "follow_up");
  const emptyResponseText = peerMessage
    ? peerMessage.intent === "result" ||
      peerMessage.intent === "status" ||
      peerMessage.intent === "question" ||
      peerMessage.repliesToRequest
      ? `Update from ${peerMessage.fromBotName}: ${peerMessage.text}`
      : DELEGATED_EMPTY_NOTICE
    : undefined;
  const capabilities = semanticMemory?.describe().capabilities;
  const recallsEachRun = capabilities?.recallEachRun === true;
  const compacted = thread.historyCompactedUpToSeq != null;
  const recallPromise =
    threadContext.includeSemanticRecall &&
    !ownerComputerRoutine &&
    semanticMemory &&
    memoryScope &&
    capabilities?.recallOnRequestOnly !== true &&
    (compacted || recallsEachRun)
      ? semanticMemory.recall(
          {
            query: task.prompt,
            includeExternal: false,
            scope: memoryScope,
            botId: bot.id,
            ...(compacted ? { historyGeneration: thread.historyCompactionGeneration } : {}),
            limit: MAX_RECALLED_MEMORIES,
          },
          context,
        )
      : Promise.resolve(null);
  const [discovered, currentTurnImages, memoryContext, scratchpadContext, ticketContext, recalled] =
    await Promise.all([
      discoveredPromise,
      loadCurrentTurnImages(deps, turnBlocks, context),
      savedContextHidden
        ? Promise.resolve("")
        : loadAgentMemoryContext(deps.memory, bot.id, context),
      savedContextHidden
        ? Promise.resolve("")
        : loadAgentScratchpadContext(deps, {
            spaceId: run.spaceId,
            botId: bot.id,
          }),
      savedContextHidden || !ticketBoardEnabled
        ? Promise.resolve(undefined)
        : loadAgentTicketContext(deps, {
            spaceId: run.spaceId,
            text: task.prompt,
          }),
      recallPromise,
    ]);
  const semanticMemoryEnabled = Boolean(semanticMemory) && !savedContextHidden;
  let recalledMemory = "";
  let recallSucceeded = false;
  if (recalled) {
    if (recalled.ok) {
      const stored = recalled.value.filter((memory) => !memory.external);
      recallSucceeded = stored.length > 0;
      // Provider extraction and recall return derived knowledge, even when the original
      // conversation was this bot's own. Storage cannot promote it to owner authority.
      recalledMemory = stored.length ? formatRecalledMemory(stored) : "";
    } else {
      getLogger().error("semantic memory recall failed", recalled.error);
    }
  }
  if (!compactedHistory.usedLocalSummary) {
    history = history.slice(
      -historyWindowSize({
        semanticMemoryEnabled: semanticMemoryEnabled && !thread.historyCompactionSummary,
        compacted,
        recallSucceeded,
      }),
    );
  }
  return {
    history,
    historyMessages,
    currentTurnMessage,
    turnBlocks,
    currentRunRequiresImageInput,
    groupReplyOptional,
    allowSilentEmptyRun,
    emptyResponseText,
    discovered,
    currentTurnImages,
    memoryContext,
    scratchpadContext,
    ticketContext,
    semanticMemoryEnabled,
    recalledMemory,
  };
}

export type TurnContext = Awaited<ReturnType<typeof loadTurnContext>>;
