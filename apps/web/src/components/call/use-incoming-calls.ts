import type { IncomingBotCall } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { followStream } from "../../lib/follow-stream";
import { rpc } from "../../lib/rpc";

const NO_CALLS: IncomingBotCall[] = [];

/** The account's ringing calls in this Space, as the server's call stream reports them. */
export function useIncomingCalls(spaceId: string | undefined): IncomingBotCall[] {
  const [calls, setCalls] = useState<IncomingBotCall[]>(NO_CALLS);
  useEffect(() => {
    if (!spaceId) return;
    const stop = followStream(
      (signal) => rpc.notifications.subscribeCalls(undefined, { signal }),
      (frame) => {
        if (frame.payload) setCalls(frame.payload.calls.filter((call) => call.spaceId === spaceId));
      },
      // Calls were turned off: nothing it last reported may keep ringing.
      () => setCalls(NO_CALLS),
    );
    return () => {
      stop();
      setCalls(NO_CALLS);
    };
  }, [spaceId]);
  return calls;
}
