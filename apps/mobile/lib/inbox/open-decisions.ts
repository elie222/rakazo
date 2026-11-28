import type { RunActivityRow, ThreadMessage } from "@rakazo/contracts";
import { chatSnoozed } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useEffect, useMemo, useState } from "react";
import { rpc } from "../api/api";
import type { InboxItem } from "./inbox-spaces";
import type { InboxSignal } from "./offscreen-unreads";

/** A question, approval or form a bot is stopped on, which only the person can answer. */
export type OpenDecision = {
  run: RunActivityRow;
  messageId: string;
  text: string;
};

type DecisionMessage = Pick<ThreadMessage, "id" | "seq" | "runId" | "blocks">;

/**
 * The decision a waiting run is stopped on, or null when there is none to make. A run's waiting
 * status alone is not enough: a run can be left waiting after the chat moved on, so the decision
 * must be the chat's newest message, from that same run, with a card still marked pending.
 */
export function openDecision(
  run: Pick<RunActivityRow, "runId" | "status">,
  messages: readonly DecisionMessage[],
  now = Date.now(),
): { messageId: string; text: string } | null {
  if (run.status !== "waiting_input") return null;
  const newest = messages.reduce<DecisionMessage | undefined>(
    (latest, message) => (!latest || message.seq > latest.seq ? message : latest),
    undefined,
  );
  if (!newest || newest.runId !== run.runId) return null;
  for (const block of newest.blocks) {
    if (block.kind === "ask" && block.status === "pending" && !block.dismissed) {
      const text = block.text.trim();
      if (text) return { messageId: newest.id, text };
    }
    if (
      block.kind === "tool_question" &&
      block.status === "pending" &&
      Date.parse(block.expiresAt) > now
    ) {
      const text = block.question.message.trim();
      if (text) return { messageId: newest.id, text };
    }
  }
  return null;
}

const runKey = (run: RunActivityRow) => `${run.runId}:${run.status}:${run.updatedAt}`;

/**
 * The decisions waiting on the person, checked against each waiting chat's newest messages.
 * Null until the first check ends, so nothing is claimed before it is confirmed. Read again
 * whenever a waiting run changes; a chat that can't be read shows no card.
 */
export function useOpenDecisions(runs: readonly RunActivityRow[]): OpenDecision[] | null {
  const [decisions, setDecisions] = useState<OpenDecision[] | null>(null);
  const waiting = runs.filter((run) => run.status === "waiting_input");
  const key = waiting.map(runKey).join("|");
  useEffect(() => {
    let current = true;
    void Promise.all(
      waiting.map(async (run): Promise<OpenDecision | null> => {
        const page = await bestEffort(
          "open decision",
          rpc("threads/messages", run.groupId ? { groupId: run.groupId } : { botId: run.botId }),
        );
        const found = page ? openDecision(run, page.messages) : null;
        return found ? { run, ...found } : null;
      }),
    ).then((found) => {
      if (current) setDecisions(found.filter((entry): entry is OpenDecision => entry !== null));
    });
    return () => {
      current = false;
    };
    // `key` names the waiting runs and their last change, so the check repeats only when one moves.
  }, [key]);
  return decisions;
}

type InboxChat = { id: string; snoozedUntil?: string | null };

/** The open decisions in the chats the inbox lists and that are awake, when `enabled`. */
export function useInboxDecisions({
  enabled,
  active,
  bots,
  groups,
}: {
  enabled: boolean;
  active: readonly RunActivityRow[];
  bots: readonly InboxChat[];
  groups: readonly InboxChat[];
}): OpenDecision[] | null {
  const waiting = useMemo(() => {
    if (!enabled) return [];
    const now = Date.now();
    const listed = (run: RunActivityRow) => {
      const chat = run.groupId
        ? groups.find((group) => group.id === run.groupId)
        : bots.find((bot) => bot.id === run.botId);
      return chat !== undefined && !chatSnoozed(chat, now);
    };
    return active.filter((run) => run.status === "waiting_input" && listed(run));
  }, [enabled, active, bots, groups]);
  return useOpenDecisions(waiting);
}

/** The bots with an open decision in a one-to-one chat, or null before the first check. */
export function decisionBotIds(
  decisions: readonly OpenDecision[] | null,
): ReadonlySet<string> | null {
  return decisions
    ? new Set(decisions.flatMap((decision) => (decision.run.groupId ? [] : [decision.run.botId])))
    : null;
}

/**
 * A row's jump-pill signal with "needs attention" meaning what Needs you means: a bot with an open
 * decision. Before the first check, the row keeps the signal it came with.
 */
export function withDecisionAttention(
  item: InboxItem,
  signal: InboxSignal,
  botIds: ReadonlySet<string> | null,
): InboxSignal {
  if (!botIds) return signal;
  if (item.type === "bot") return { ...signal, attention: botIds.has(item.bot.id) ? 1 : 0 };
  if (item.type === "pinned") {
    const attention = item.chats.filter(
      (chat) => chat.kind === "bot" && botIds.has(chat.bot.id),
    ).length;
    return { ...signal, attention };
  }
  return signal;
}
