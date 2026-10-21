import type { ThreadMessage } from "@rakazo/contracts";

const PEER_HISTORY_PAGE_TIMEOUT_MS = 15_000;
const PEER_HISTORY_TOTAL_TIMEOUT_MS = 60_000;

type PeerHistoryPage = {
  messages: ThreadMessage[];
  olderCursor: number | null;
};

/** Load every page, with bounded requests and cancellation on web and native runtimes. */
export async function loadPeerHistory({
  signal,
  loadPage,
  pageTimeoutMs = PEER_HISTORY_PAGE_TIMEOUT_MS,
  totalTimeoutMs = PEER_HISTORY_TOTAL_TIMEOUT_MS,
}: {
  signal: AbortSignal;
  loadPage: (before: number | undefined, signal: AbortSignal) => Promise<PeerHistoryPage>;
  pageTimeoutMs?: number;
  totalTimeoutMs?: number;
}): Promise<ThreadMessage[]> {
  const deadline = Date.now() + totalTimeoutMs;
  const collected: ThreadMessage[][] = [];
  let before: number | undefined;
  do {
    if (signal.aborted) throw signal.reason ?? namedError("AbortError");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw namedError("TimeoutError");
    // Native AbortSignal implementations need not provide the static any/timeout helpers.
    const request = new AbortController();
    let rejectAborted: (reason: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const abort = (reason: unknown) => {
      request.abort(reason);
      rejectAborted(reason);
    };
    const onAbort = () => abort(signal.reason ?? namedError("AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => abort(namedError("TimeoutError")),
      Math.min(pageTimeoutMs, remaining),
    );
    try {
      const page = await Promise.race([loadPage(before, request.signal), aborted]);
      collected.push(page.messages);
      before = page.olderCursor ?? undefined;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  } while (before !== undefined);
  return collected.reverse().flat();
}

function namedError(name: "AbortError" | "TimeoutError"): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
