import {
  abortableDelay,
  createRefreshCoalescer,
  isRetryableError,
  isRunTerminalEvent,
  messageUnreadFor,
  reduceThreadSnapshot,
  rememberTerminalRun,
  retryDelayMs,
} from "@rakazo/core";
import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { rpc } from "./api";
import { subscribeThread } from "./api-live";
import { getHapticsEnabled, hapticSuccess } from "./haptics";
import type { MobileSnapshot } from "./mobile-types";
import { currentSessionGeneration } from "./session";
import type { ThreadJumpAnchor } from "./thread-jump";
import type { PinnedThreadWindow } from "./thread-window";
import { errorText } from "./user-error";

type FeedbackBoundary = {
  cursor: number | null;
  pending: Map<string, number>;
  ready: Promise<number | null>;
};

const FEEDBACK_HEAD_BUDGET_MS = 250;

/**
 * Streams the chat's live events while the app is in the foreground. Returning to the same chat
 * resumes from the last applied event, so pinned and expanded windows catch up without a gap;
 * another chat or session starts fresh. Returns whether the stream is connected right now.
 */
export function useThreadLiveSubscription({
  botId,
  groupId,
  foreground,
  focused = false,
  readOnly,
  sessionEpoch,
  userId,
  messageId,
  historyEpoch,
  expandedHistoryThread,
  pinnedAroundRef,
  jumpScrollTarget,
  jumpAnchor,
  snapRef,
  terminalRunIds,
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
  focused?: boolean;
  readOnly: boolean;
  sessionEpoch: number;
  /** The signed-in person: another member's message is new to them, their own is not. */
  userId: string;
  /** A pending search jump, which loads its own page instead of the latest one. */
  messageId?: string;
  historyEpoch: RefObject<number>;
  expandedHistoryThread: RefObject<string | null>;
  pinnedAroundRef: RefObject<PinnedThreadWindow | null>;
  jumpScrollTarget: RefObject<string | null>;
  jumpAnchor: RefObject<ThreadJumpAnchor>;
  snapRef: RefObject<MobileSnapshot | null>;
  terminalRunIds: RefObject<Set<string>>;
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
  const liveProjectionFloor = useRef(-1);
  const liveSubscriptionGeneration = useRef(0);
  const completedRuns = useRef(new Set<string>());
  const feedbackBoundary = useRef<FeedbackBoundary | null>(null);
  const visible = useRef(false);
  visible.current = foreground && focused;

  useEffect(() => {
    liveCursor.current = null;
    liveProjectionFloor.current = -1;
    completedRuns.current.clear();
  }, [botId, groupId, sessionEpoch]);

  useEffect(() => {
    feedbackBoundary.current = null;
    if ((!botId && !groupId) || !foreground || !focused || readOnly || !getHapticsEnabled()) return;
    const abort = new AbortController();
    const generation = currentSessionGeneration();
    let settleFirst!: (cursor: number | null) => void;
    const boundary: FeedbackBoundary = {
      cursor: null,
      pending: new Map(),
      ready: new Promise((resolve) => {
        settleFirst = resolve;
      }),
    };
    feedbackBoundary.current = boundary;
    const current = () =>
      !abort.signal.aborted &&
      generation === currentSessionGeneration() &&
      feedbackBoundary.current === boundary &&
      visible.current;
    void (async () => {
      let backoff = 250;
      let firstAttempt = true;
      while (current() && getHapticsEnabled()) {
        let failure: unknown;
        try {
          const head = await rpc("threads/head", groupId ? { groupId } : { botId: botId! }, {
            signal: abort.signal,
            ...(firstAttempt ? { timeoutMs: FEEDBACK_HEAD_BUDGET_MS } : {}),
          });
          if (!current()) return;
          boundary.cursor = head.cursor;
          for (const seq of boundary.pending.values()) {
            if (seq > head.cursor) hapticSuccess();
          }
          boundary.pending.clear();
          return;
        } catch (error) {
          failure = error;
          boundary.pending.clear();
        } finally {
          if (firstAttempt) settleFirst(boundary.cursor);
          firstAttempt = false;
        }
        if (!current() || !isRetryableError(failure)) break;
        await abortableDelay(retryDelayMs(failure, backoff), abort.signal);
        backoff = Math.min(backoff * 2, 5_000);
      }
      boundary.pending.clear();
      if (feedbackBoundary.current === boundary) feedbackBoundary.current = null;
    })();
    return () => {
      abort.abort();
      settleFirst(null);
      boundary.pending.clear();
      if (feedbackBoundary.current === boundary) feedbackBoundary.current = null;
    };
  }, [botId, groupId, foreground, focused, readOnly, sessionEpoch]);

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
      const resuming = liveCursor.current !== null;
      const next = resuming
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
      if (!resuming) liveProjectionFloor.current = next?.cursor ?? -1;
      const projectionFloor = liveProjectionFloor.current;
      if (!resuming) {
        const boundary = feedbackBoundary.current;
        if (boundary) {
          const floor =
            boundary.cursor ??
            (await Promise.race([
              boundary.ready,
              abortableDelay(FEEDBACK_HEAD_BUDGET_MS, abort.signal).then(() => null),
            ]));
          if (abort.signal.aborted || sessionGeneration !== currentSessionGeneration()) return;
          if (feedbackBoundary.current === boundary && floor !== null)
            cursor = Math.min(cursor, floor);
        }
      }
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
              const newEvent = (event.seq ?? -1) > cursor;
              cursor = Math.max(cursor, event.seq ?? -1);
              retryMs = 250;
              liveCursor.current = cursor;
              rememberTerminalRun(terminalRunIds.current, event);
              if (
                event.type === "run.completed" &&
                event.runId &&
                !completedRuns.current.has(event.runId)
              ) {
                completedRuns.current.add(event.runId);
                const boundary = feedbackBoundary.current;
                if (newEvent && visible.current && boundary) {
                  if (boundary.cursor === null) {
                    boundary.pending.set(event.runId, event.seq ?? -1);
                  } else if ((event.seq ?? -1) > boundary.cursor) {
                    hapticSuccess();
                  }
                }
              }
              const shouldProject = (event.seq ?? -1) > projectionFloor;
              if (!shouldProject && !newEvent) return;
              if (shouldProject) {
                if (event.type === "thread.cleared") {
                  expandedHistoryThread.current = null;
                  pinnedAroundRef.current = null;
                  jumpScrollTarget.current = null;
                  jumpAnchor.current.release();
                  historyEpoch.current += 1;
                }
                const previous = snapRef.current;
                const reduced = reduceThreadSnapshot(previous, event);
                if (reduced !== previous) commitSnap(reduced);
              }
              if (event.type === "bot.updated") {
                void refreshMentionBots();
              }
              if (
                event.type === "thread.message.created" &&
                messageUnreadFor(event.payload ?? {}, userId)
              ) {
                readVisibleTarget.current = null;
                markReadIfVisible();
              }
              if (isRunTerminalEvent(event)) {
                void refreshMentionBots();
              }
              if (
                shouldProject &&
                (isRunTerminalEvent(event) || event.type === "run.waiting_input")
              ) {
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
  }, [
    botId,
    groupId,
    foreground,
    readOnly,
    markReadIfVisible,
    refreshMentionBots,
    sessionEpoch,
    userId,
  ]);

  return liveSubscribed;
}
