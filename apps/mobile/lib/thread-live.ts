import {
  abortableDelay,
  createRefreshCoalescer,
  isRetryableError,
  isRunTerminalEvent,
  retryDelayMs,
} from "@rakazo/core";
import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import type { MobileSnapshot } from "./api";
import { applyMobileThreadEvent, rpc, subscribeThread } from "./api";
import { currentSessionGeneration } from "./session";
import type { ThreadJumpAnchor } from "./thread-jump";
import type { PinnedThreadWindow } from "./thread-window";
import { errorText } from "./user-error";

/**
 * Streams the chat's live events while the app is in the foreground. Returning to the same chat
 * resumes from the last applied event, so pinned and expanded windows catch up without a gap;
 * another chat or session starts fresh. Returns whether the stream is connected right now.
 */
export function useThreadLiveSubscription({
  botId,
  groupId,
  foreground,
  readOnly,
  sessionEpoch,
  messageId,
  historyEpoch,
  expandedHistoryThread,
  pinnedAroundRef,
  jumpScrollTarget,
  jumpAnchor,
  snapRef,
  readVisibleTarget,
  showSavedThread,
  refresh,
  commitSnap,
  setError,
  refreshMentionBots,
  markReadIfVisible,
}: {
  botId?: string;
  groupId?: string;
  foreground: boolean;
  readOnly: boolean;
  sessionEpoch: number;
  /** A pending search jump, which loads its own page instead of the latest one. */
  messageId?: string;
  historyEpoch: RefObject<number>;
  expandedHistoryThread: RefObject<string | null>;
  pinnedAroundRef: RefObject<PinnedThreadWindow | null>;
  jumpScrollTarget: RefObject<string | null>;
  jumpAnchor: RefObject<ThreadJumpAnchor>;
  snapRef: RefObject<MobileSnapshot | null>;
  readVisibleTarget: RefObject<string | null>;
  showSavedThread: (signal: AbortSignal) => void;
  refresh: () => Promise<MobileSnapshot | undefined>;
  commitSnap: (next: MobileSnapshot | null) => void;
  setError: (error: string | null) => void;
  refreshMentionBots: () => Promise<unknown>;
  markReadIfVisible: () => void;
}): RefObject<boolean> {
  const liveSubscribed = useRef(false);
  const liveCursor = useRef<number | null>(null);
  const liveSubscriptionGeneration = useRef(0);

  useEffect(() => {
    liveCursor.current = null;
  }, [botId, groupId, sessionEpoch]);

  useEffect(() => {
    // Resume the same chat from its applied cursor so pinned and expanded windows catch up.
    if ((!botId && !groupId) || !foreground) return;
    // Invalidate pending history loads while retaining pages already loaded for this chat.
    historyEpoch.current += 1;
    const abort = new AbortController();
    const subscriptionGeneration = ++liveSubscriptionGeneration.current;
    const sessionGeneration = currentSessionGeneration();
    // Guards are checked when the queued read starts, not when it was requested.
    const snapshotRefresh = createRefreshCoalescer(async () => {
      if (
        sessionGeneration === currentSessionGeneration() &&
        !jumpScrollTarget.current &&
        !expandedHistoryThread.current
      ) {
        await refresh();
      }
    });
    liveSubscribed.current = false;
    showSavedThread(abort.signal);
    void (async () => {
      // Pending search jumps load the around-page separately; avoid replacing it with latest.
      const next =
        liveCursor.current !== null
          ? null
          : messageId
            ? await rpc("threads/get", groupId ? { groupId } : { botId: botId! }).catch(
                (err: unknown) => {
                  setError(errorText(err));
                  return null;
                },
              )
            : await refresh().catch((err: unknown) => {
                setError(errorText(err));
                return null;
              });
      if (abort.signal.aborted || readOnly) return;
      let cursor = liveCursor.current ?? next?.cursor ?? -1;
      liveCursor.current = cursor;
      let retryMs = 250;
      while (!abort.signal.aborted && sessionGeneration === currentSessionGeneration()) {
        let failure: unknown;
        try {
          liveSubscribed.current = true;
          await subscribeThread(
            groupId ? { groupId } : { botId: botId! },
            cursor,
            (event) => {
              if (abort.signal.aborted || sessionGeneration !== currentSessionGeneration()) return;
              cursor = Math.max(cursor, event.seq ?? -1);
              retryMs = 250;
              if (event.type === "thread.cleared") {
                expandedHistoryThread.current = null;
                pinnedAroundRef.current = null;
                jumpScrollTarget.current = null;
                jumpAnchor.current.release();
                historyEpoch.current += 1;
              }
              const previous = snapRef.current;
              const reduced = applyMobileThreadEvent(previous, event);
              if (reduced !== previous) commitSnap(reduced);
              liveCursor.current = cursor;
              if (event.type === "bot.updated") {
                void refreshMentionBots();
              }
              if (event.type === "thread.message.created" && event.payload?.role === "bot") {
                readVisibleTarget.current = null;
                markReadIfVisible();
              }
              if (isRunTerminalEvent(event)) {
                void refreshMentionBots();
              }
              if (isRunTerminalEvent(event) || event.type === "run.waiting_input") {
                // Reconcile run ownership for ask cards first seen through live events.
                void snapshotRefresh.invalidate().catch(() => undefined);
              }
            },
            abort.signal,
          );
        } catch (error) {
          // A full refresh reconciles visible state; the event cursor still resumes without gaps.
          failure = error;
        } finally {
          if (liveSubscriptionGeneration.current === subscriptionGeneration) {
            liveSubscribed.current = false;
          }
        }
        // A 4xx other than 408/429 is the server's answer; reconnecting only polls it.
        if (abort.signal.aborted || !isRetryableError(failure)) break;
        let refreshFailure: unknown;
        if (!jumpScrollTarget.current && !expandedHistoryThread.current) {
          refreshFailure = await refresh().then(
            () => undefined,
            (error: unknown) => error,
          );
          if (!isRetryableError(refreshFailure)) break;
        }
        // Wait as long as either request was asked to (a 429's Retry-After).
        const delay = Math.max(
          retryDelayMs(failure, retryMs),
          retryDelayMs(refreshFailure, retryMs),
        );
        await abortableDelay(delay, abort.signal);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    })();
    return () => {
      snapshotRefresh.dispose();
      abort.abort();
    };
  }, [botId, groupId, foreground, readOnly, markReadIfVisible, refreshMentionBots, sessionEpoch]);

  return liveSubscribed;
}
