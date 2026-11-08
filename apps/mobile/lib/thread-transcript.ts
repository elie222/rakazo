import {
  expandPeerReplies,
  foldPeerReplies,
  peerExchangeLines,
  projectBotMentions,
  projectMessageReactions,
  shouldShowBotSenderName,
} from "@rakazo/core";
import { useMemo, useState, useSyncExternalStore } from "react";
import { applyLocalChoiceDismissals, hasVisibleMessagePresentation } from "./message-presentation";
import type { MobileMessage } from "./mobile-types";
import { getCachedToolActivityEnabled, subscribeToolActivity } from "./tool-activity-preference";

/**
 * What the chat draws from its messages: peer replies folded under their marker until expanded,
 * mentions and reactions folded into the message they belong to, and choices the user dismissed
 * here hidden.
 */
export function useThreadTranscript(messages: MobileMessage[] | undefined, inGroup: boolean) {
  const [dismissedChoiceQuestions, setDismissedChoiceQuestions] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const [expandedPeerMarkers, setExpandedPeerMarkers] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const showToolActivity = useSyncExternalStore(
    subscribeToolActivity,
    getCachedToolActivityEnabled,
    () => false,
  );
  const showBotSenderName = useMemo(
    () =>
      shouldShowBotSenderName({
        isGroup: inGroup,
        speakerBotIds: (messages ?? [])
          .filter((message) => message.role === "bot")
          .map((message) => message.botId),
      }),
    [inGroup, messages],
  );
  const peerTranscript = useMemo(
    () => foldPeerReplies(messages ?? [], { includePeerReceipts: true }),
    [messages],
  );
  const reactionView = useMemo(() => {
    const mentionView = projectBotMentions(
      expandPeerReplies(peerTranscript, expandedPeerMarkers)
        .map((message) => {
          const dismissed = dismissedChoiceQuestions.get(message.id);
          if (!dismissed) return message;
          const blocks = applyLocalChoiceDismissals(message.blocks, dismissed);
          return blocks === message.blocks ? message : { ...message, blocks: [...blocks] };
        })
        .filter((message) => hasVisibleMessagePresentation(message.blocks, showToolActivity)),
    );
    return {
      ...projectMessageReactions(mentionView.visibleMessages),
      mentions: mentionView.mentions,
      foldedInto: mentionView.foldedInto,
    };
  }, [dismissedChoiceQuestions, expandedPeerMarkers, peerTranscript, showToolActivity]);

  function dismissChoice(messageId: string, question: string) {
    setDismissedChoiceQuestions((current) => {
      const existing = current.get(messageId);
      if (existing?.has(question)) return current;
      const next = new Map(current);
      const questions = new Set(existing);
      questions.add(question);
      next.set(messageId, questions);
      return next;
    });
  }

  const exchanges = useMemo(
    () =>
      peerExchangeLines({
        ...peerTranscript,
        messages: reactionView.visibleMessages,
      }),
    [peerTranscript, reactionView],
  );
  const visibleMessages = useMemo(
    () =>
      reactionView.visibleMessages.filter(
        (message) => !exchanges.lineOf.has(message.id) || exchanges.lines.has(message.id),
      ),
    [reactionView, exchanges],
  );

  return {
    showBotSenderName,
    peerTranscript,
    reactionView,
    setExpandedPeerMarkers,
    dismissChoice,
    exchanges,
    visibleMessages,
  };
}
