import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { ThreadMessage } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";

/** Long enough for the 450ms entrance; a later arrival restarts it. */
const ENTER_MS = 500;
const EMPTY: ReadonlySet<string> = new Set();

/**
 * Which messages landed after the first paint. History and earlier pages stay still, and the live
 * `progress:` row is excluded because it is already on screen while its text streams.
 */
export function useEnteringMessages(messages: readonly ThreadMessage[]): ReadonlySet<string> {
  const shown = useRef<{ ids: ReadonlySet<string>; lastSeq: number } | null>(null);
  const [entering, setEntering] = useState<ReadonlySet<string>>(EMPTY);

  useEffect(() => {
    const previous = shown.current;
    const ids = new Set(messages.map((message) => message.id));
    const lastSeq = messages.reduce((last, message) => Math.max(last, message.seq), 0);
    shown.current = { ids, lastSeq };
    if (!previous) return;
    const fresh = messages
      .filter(
        (message) =>
          !previous.ids.has(message.id) &&
          message.seq > previous.lastSeq &&
          !message.id.startsWith("progress:"),
      )
      .map((message) => message.id);
    if (fresh.length > 0) setEntering(new Set(fresh));
  }, [messages]);

  useTimeout(() => setEntering(EMPTY), entering.size > 0 ? ENTER_MS : null, entering);

  return entering;
}
