import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { ThreadMessage } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";

/** Long enough for the 450ms entrance; a later arrival restarts it. */
const ENTER_MS = 500;
const EMPTY: ReadonlySet<string> = new Set();

/** A row that may be a live one, which carries no message seq. */
type SeqMessage = Pick<ThreadMessage, "id"> & { seq?: number };

/**
 * Which messages landed after the first paint. History and earlier pages stay still, and the live
 * `progress:` row is excluded because it is already on screen while its text streams.
 */
export function useEnteringMessages(messages: readonly SeqMessage[]): ReadonlySet<string> {
  const shown = useRef<{ ids: ReadonlySet<string>; lastSeq: number } | null>(null);
  const [entering, setEntering] = useState<ReadonlySet<string>>(EMPTY);

  useEffect(() => {
    const previous = shown.current;
    const ids = new Set(messages.map((message) => message.id));
    // Live rows (progress, tool steps, subagents) carry no message seq; leaving them out of the
    // high-water mark keeps it a number instead of turning every later comparison into NaN.
    const lastSeq = messages.reduce((last, message) => Math.max(last, message.seq ?? 0), 0);
    shown.current = { ids, lastSeq };
    if (!previous) return;
    const fresh = messages
      .filter(
        (message) =>
          !previous.ids.has(message.id) &&
          message.seq !== undefined &&
          message.seq > previous.lastSeq &&
          !message.id.startsWith("progress:"),
      )
      .map((message) => message.id);
    // Keep the rows still playing: a second reply within the entrance window must not cut the
    // first animation short by replacing the set.
    if (fresh.length > 0) setEntering((current) => new Set([...current, ...fresh]));
  }, [messages]);

  useTimeout(() => setEntering(EMPTY), entering.size > 0 ? ENTER_MS : null, entering);

  return entering;
}
