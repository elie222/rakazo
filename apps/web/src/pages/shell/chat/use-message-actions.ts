import type { ThreadMessage } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useCallback } from "react";
import { hasOpenDialog } from "../../../lib/platform/has-open-dialog";

/** Replying to, quoting and marking unread a message in the open chat's transcript. */
export function useMessageActions({
  activeId,
  groupId,
  setReplyTarget,
  setReplyQuote,
  focusComposer,
  quoteBlocked,
  markBotUnread,
  markGroupUnreadFrom,
}: {
  activeId: string | undefined;
  groupId: string | undefined;
  setReplyTarget: (message: ThreadMessage | null) => void;
  setReplyQuote: (quote: string | null) => void;
  focusComposer: () => boolean;
  /** Something covers the chat (the computer, the drawer or a panel on a phone), so a quote waits. */
  quoteBlocked: boolean;
  markBotUnread: (id: string, messageId?: string) => Promise<unknown>;
  markGroupUnreadFrom: (groupId: string, messageId: string) => void;
}) {
  const replyToMessage = useCallback(
    (message: ThreadMessage) => {
      setReplyTarget(message);
      setReplyQuote(null);
    },
    [setReplyQuote, setReplyTarget],
  );
  const quoteMessage = useCallback(
    (message: ThreadMessage, quote: string) => {
      if (quoteBlocked || hasOpenDialog(document, true)) return;
      setReplyTarget(message);
      setReplyQuote(quote);
      focusComposer();
    },
    [setReplyQuote, setReplyTarget, focusComposer, quoteBlocked],
  );
  const markMessageUnread = useCallback(
    (message: ThreadMessage) => {
      if (groupId) markGroupUnreadFrom(groupId, message.id);
      else if (activeId) void bestEffort("mark chat unread", markBotUnread(activeId, message.id));
    },
    [activeId, groupId, markBotUnread, markGroupUnreadFrom],
  );
  return { replyToMessage, quoteMessage, markMessageUnread };
}
