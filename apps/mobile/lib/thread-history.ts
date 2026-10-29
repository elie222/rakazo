import { liveMessageComposing, withLiveStreamingProgress } from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MobileSnapshot } from "./api";
import {
  getCachedResponseStreamingEnabled,
  subscribeResponseStreaming,
} from "./response-streaming";
import type { SavedChatsScope } from "./saved-chats";
import { ThreadJumpAnchor } from "./thread-jump";
import { reconcileVisibleThreadSnapshot } from "./thread-snapshot";
import type { PinnedThreadWindow } from "./thread-window";

/** The chat on screen and the refs that place it on the live thread, loaded history or a pinned page. */
export type ThreadHistory = {
  snap: MobileSnapshot | null;
  /** Bots writing reply text right now, comma-separated. */
  composingBots: string;
  /** The copy saved on this device stays on screen until a live snapshot replaces it. */
  showingSaved: boolean;
  setShowingSaved: (showing: boolean) => void;
  commitSnap: (next: MobileSnapshot | null) => void;
  /** Empties the conversation after it was cleared, dropping loaded history and pending loads. */
  clear: () => void;
  snapRef: RefObject<MobileSnapshot | null>;
  snapshotOrigin: RefObject<SavedChatsScope | null>;
  pendingSave: RefObject<(() => void) | null>;
  expandedHistoryThread: RefObject<string | null>;
  historyEpoch: RefObject<number>;
  jumpGeneration: RefObject<number>;
  refreshGeneration: RefObject<number>;
  pinnedAroundRef: RefObject<PinnedThreadWindow | null>;
  jumpScrollTarget: RefObject<string | null>;
  jumpAnchor: RefObject<ThreadJumpAnchor>;
  joinPinnedAfterLayout: RefObject<number | null>;
  /** A failed newer page waits for the next drag instead of retrying on every scroll event. */
  newerLoadFailed: RefObject<boolean>;
  pinnedScrollMetrics: RefObject<{ offset: number; viewport: number; content: number }>;
  loadingOlderContent: RefObject<boolean>;
  loadingNewerContent: RefObject<boolean>;
};

/** Owns the chat's snapshot: what is committed, what is shown, and the history window refs. */
export function useThreadSnapshot(): ThreadHistory {
  const [snap, setSnap] = useState<MobileSnapshot | null>(null);
  const [composingBots, setComposingBots] = useState("");
  const [showingSaved, setShowingSaved] = useState(false);
  const snapRef = useRef<MobileSnapshot | null>(null);
  const snapshotOrigin = useRef<SavedChatsScope | null>(null);
  const pendingSave = useRef<(() => void) | null>(null);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const pinnedAroundRef = useRef<PinnedThreadWindow | null>(null);
  const jumpScrollTarget = useRef<string | null>(null);
  const jumpAnchor = useRef(new ThreadJumpAnchor());
  const joinPinnedAfterLayout = useRef<number | null>(null);
  const newerLoadFailed = useRef(false);
  const pinnedScrollMetrics = useRef({ offset: 0, viewport: 0, content: 0 });
  const loadingOlderContent = useRef(false);
  const loadingNewerContent = useRef(false);
  const streamResponses = useSyncExternalStore(
    subscribeResponseStreaming,
    getCachedResponseStreamingEnabled,
    () => false,
  );
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;

  const commitSnap = useCallback((next: MobileSnapshot | null) => {
    snapRef.current = next;
    const visible = withLiveStreamingProgress(next, streamResponsesRef.current);
    setSnap((previous) => reconcileVisibleThreadSnapshot(previous, visible));
    // Read before streamed text is hidden, so a writing bot shows it even with streaming off.
    setComposingBots(
      (next?.messages ?? [])
        .filter(
          (message) => message.id.startsWith("progress:") && liveMessageComposing(message.blocks),
        )
        .map((message) => message.botId ?? next?.botId ?? "")
        .sort()
        .join(","),
    );
  }, []);

  useEffect(() => {
    commitSnap(snapRef.current);
  }, [streamResponses]);

  function clear() {
    expandedHistoryThread.current = null;
    pinnedAroundRef.current = null;
    historyEpoch.current += 1;
    commitSnap(
      snapRef.current
        ? { ...snapRef.current, messages: [], olderCursor: null, run: null }
        : snapRef.current,
    );
  }

  return {
    snap,
    composingBots,
    showingSaved,
    setShowingSaved,
    commitSnap,
    clear,
    snapRef,
    snapshotOrigin,
    pendingSave,
    expandedHistoryThread,
    historyEpoch,
    jumpGeneration,
    refreshGeneration,
    pinnedAroundRef,
    jumpScrollTarget,
    jumpAnchor,
    joinPinnedAfterLayout,
    newerLoadFailed,
    pinnedScrollMetrics,
    loadingOlderContent,
    loadingNewerContent,
  };
}
