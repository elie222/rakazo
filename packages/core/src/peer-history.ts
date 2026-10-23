import { anySignal } from "./async.js";

const PEER_HISTORY_PAGE_TIMEOUT_MS = 15_000;
const PEER_HISTORY_TOTAL_TIMEOUT_MS = 60_000;

type PeerHistoryPage<T> = {
  messages: readonly T[];
  olderCursor: number | null;
};

/** Load every peer-history page without allowing one request or the full scan to hang forever. */
export async function loadPeerHistory<T>({
  signal,
  loadPage,
  pageTimeoutMs = PEER_HISTORY_PAGE_TIMEOUT_MS,
  totalTimeoutMs = PEER_HISTORY_TOTAL_TIMEOUT_MS,
}: {
  signal: AbortSignal;
  loadPage: (before: number | undefined, signal: AbortSignal) => Promise<PeerHistoryPage<T>>;
  pageTimeoutMs?: number;
  totalTimeoutMs?: number;
}): Promise<T[]> {
  const deadline = AbortSignal.timeout(totalTimeoutMs);
  let before: number | undefined;
  let collected: T[] = [];
  do {
    const page = await loadPage(
      before,
      anySignal([signal, deadline, AbortSignal.timeout(pageTimeoutMs)]),
    );
    collected = [...page.messages, ...collected];
    before = page.olderCursor ?? undefined;
  } while (before !== undefined);
  return collected;
}
