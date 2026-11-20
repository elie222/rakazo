import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { ThreadMessage } from "@rakazo/contracts";
import { isPeerReceiptBlocks, selectableMessageText, truncatedPlainText } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";

const ANNOUNCED_CHARS = 200;
const REPEAT_GAP_MS = 100;

/**
 * What a screen reader hears when a bot's reply lands at the end of the chat: the sender and the
 * start of the text. Only finished messages count (the live `progress:` message streams and is
 * never announced), and only ones newer than everything already shown, so the first load, earlier
 * history and your own messages stay quiet. The transcript is keyed by thread and mounts once the
 * thread has loaded, so its first render is the first load, even when the thread is empty.
 */
export function useReplyAnnouncement(
  messages: readonly ThreadMessage[],
  senderName: (message: ThreadMessage) => string,
): string {
  const shown = useRef<{ ids: ReadonlySet<string>; lastSeq: number } | null>(null);
  const [announcement, setAnnouncement] = useState<{ text: string; repeat: boolean } | null>(null);
  const nameOf = useRef(senderName);
  nameOf.current = senderName;
  useEffect(() => {
    const finished = messages.filter((message) => !message.id.startsWith("progress:"));
    const previous = shown.current;
    shown.current = {
      ids: new Set(finished.map((message) => message.id)),
      lastSeq: finished.reduce((last, message) => Math.max(last, message.seq), 0),
    };
    if (!previous) return;
    const reply = finished.findLast(
      (message) =>
        message.role === "bot" &&
        message.seq > previous.lastSeq &&
        !previous.ids.has(message.id) &&
        !isPeerReceiptBlocks(message.blocks),
    );
    const text = reply ? truncatedPlainText(selectableMessageText(reply), ANNOUNCED_CHARS) : "";
    if (reply && text) {
      const next = `${nameOf.current(reply)}: ${text}`;
      setAnnouncement((current) => ({ text: next, repeat: current?.text === next }));
    }
  }, [messages]);

  // Leave the mounted status empty for a separate DOM update before publishing identical text.
  useTimeout(
    () => setAnnouncement((current) => (current?.repeat ? { ...current, repeat: false } : current)),
    announcement?.repeat ? REPEAT_GAP_MS : null,
    announcement,
  );
  return announcement && !announcement.repeat ? announcement.text : "";
}
