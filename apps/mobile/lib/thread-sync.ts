import { isRetryableError } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect } from "react";
import { mergeMobileSnapshot, mobileThreadRefreshResult, rpc, selectedSpaceId } from "./api";
import { useI18n } from "./i18n";
import { isIntegrationsScopeCurrent } from "./integrations-cache";
import { threadRefreshDelayMs } from "./refresh";
import {
  liveSavedChatsScope,
  readSavedThread,
  savedChatsScope,
  savedChatTarget,
  writeSavedThread,
} from "./saved-chats";
import { currentSessionGeneration } from "./session";
import type { ThreadHistory } from "./thread-history";
import type { ThreadListScroll } from "./thread-list-scroll";
import { useThreadLiveSubscription } from "./thread-live";
import type { ThreadJump } from "./thread-window";
import { applyThreadMessageJump, showLatestThread } from "./thread-window";
import { errorText } from "./user-error";

/**
 * Keeps the chat's snapshot current: the saved copy until live data arrives, refreshes, the live
 * stream, the safety refresh, saving the latest messages, and search jumps.
 *
 * Effect order matters and matches the screen before this hook was split out: the live
 * subscription bumps the history epoch before the search jump effect captures it, and the pending
 * save flush runs before a new save is scheduled.
 */
export function useThreadSync({
  history,
  scroll,
  botId,
  groupId,
  messageId,
  readOnly,
  foreground,
  sessionEpoch,
  activeBotId,
  activeGroupId,
  readVisibleTarget,
  setExpandedPeerMarkers,
  setError,
  onRefreshed,
  refreshMentionBots,
  markReadIfVisible,
}: {
  history: ThreadHistory;
  scroll: ThreadListScroll;
  botId?: string;
  groupId?: string;
  /** A search hit to open the chat around. */
  messageId?: string;
  readOnly: boolean;
  foreground: boolean;
  sessionEpoch: number;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  readVisibleTarget: RefObject<string | null>;
  setExpandedPeerMarkers: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setError: (error: string | null) => void;
  /** A refresh for the chat on screen finished, committed or not. */
  onRefreshed: (threadKey: string | undefined) => void;
  refreshMentionBots: () => Promise<unknown>;
  markReadIfVisible: () => void;
}) {
  const { t } = useI18n();
  const {
    snap,
    showingSaved,
    setShowingSaved,
    commitSnap,
    snapRef,
    snapshotOrigin,
    pendingSave,
    expandedHistoryThread,
    historyEpoch,
    refreshGeneration,
    pinnedAroundRef,
    jumpScrollTarget,
    jumpAnchor,
  } = history;

  function isCurrentTarget(targetBotId: string | undefined, targetGroupId: string | undefined) {
    return activeBotId.current === targetBotId && activeGroupId.current === targetGroupId;
  }

  /** Shows the chat's saved copy until live data for it arrives; never under a search jump. */
  function showSavedThread(signal: AbortSignal) {
    const target = savedChatTarget({ botId, groupId });
    // Another chat's messages must never stay on screen under this chat's name.
    if (snapRef.current && savedChatTarget(snapRef.current) !== target) {
      commitSnap(null);
      setShowingSaved(false);
    }
    void savedChatsScope().then((scope) => {
      if (signal.aborted || !scope) return;
      const onScreen = snapRef.current;
      if (messageId || (onScreen && savedChatTarget(onScreen) === target)) return;
      const saved = readSavedThread(scope, target);
      if (!saved) return;
      snapshotOrigin.current = scope;
      commitSnap(saved);
      setShowingSaved(true);
    });
  }

  async function refresh() {
    if (!botId && !groupId) return;
    const targetBotId = botId;
    const targetGroupId = groupId;
    const epoch = historyEpoch.current;
    const origin = {
      sessionGeneration: currentSessionGeneration(),
      selectionId: selectedSpaceId(),
    };
    const generation = ++refreshGeneration.current;
    const next = await rpc(
      "threads/get",
      targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },
    );
    if (
      origin.sessionGeneration !== currentSessionGeneration() ||
      origin.selectionId !== selectedSpaceId()
    )
      return;
    const scope = await liveSavedChatsScope();
    if (
      !scope ||
      scope.sessionGeneration !== origin.sessionGeneration ||
      scope.selectionId !== origin.selectionId ||
      !isIntegrationsScopeCurrent(scope)
    )
      return;
    // Only the newest started refresh may commit. Threads also receive live
    // events; an older snapshot must not overwrite those while a newer refresh
    // is already in flight. The subscription starts from the snapshot returned
    // here, so a discarded fetch must not supply its cursor.
    const result = mobileThreadRefreshResult({
      fetched: next,
      onScreen: snapRef.current,
      requestGeneration: generation,
      currentGeneration: refreshGeneration.current,
      requestEpoch: epoch,
      currentEpoch: historyEpoch.current,
      targetBotId,
      targetGroupId,
      activeBotId: activeBotId.current,
      activeGroupId: activeGroupId.current,
    });
    if (result.commit) {
      snapshotOrigin.current = scope;
      pendingSave.current = null;
      writeSavedThread(scope, savedChatTarget(next), next);
      commitSnap(
        mergeMobileSnapshot(snapRef.current, next, expandedHistoryThread.current === next.threadId),
      );
      setShowingSaved(false);
    }
    if (isCurrentTarget(targetBotId, targetGroupId)) {
      onRefreshed(targetGroupId ?? targetBotId);
    }
    return result.snapshot ?? undefined;
  }

  const threadJump: ThreadJump = {
    ...history,
    scrollBehavior: scroll.behavior,
    setThreadScrollState: scroll.setState,
    activeBotId,
    activeGroupId,
    setExpandedPeerMarkers,
  };

  function applyMessageJump(target: { botId?: string; groupId?: string; messageId: string }) {
    return applyThreadMessageJump(threadJump, target);
  }

  function showLatest() {
    showLatestThread(threadJump);
  }

  const liveSubscribed = useThreadLiveSubscription({
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
  });

  useEffect(() => () => pendingSave.current?.(), [botId, groupId]);

  // Save the latest messages of the live chat (not a jump or loaded history) once updates settle.
  useEffect(() => {
    if (
      !snap ||
      showingSaved ||
      jumpScrollTarget.current ||
      pinnedAroundRef.current ||
      expandedHistoryThread.current
    )
      return;
    const target = savedChatTarget({ botId, groupId });
    const latest = snapRef.current;
    if (!latest || savedChatTarget(latest) !== target) return;
    const origin = snapshotOrigin.current;
    if (!origin) return;
    const write = () => writeSavedThread(origin, target, latest);
    pendingSave.current = write;
    const timer = setTimeout(() => {
      pendingSave.current?.();
      pendingSave.current = null;
    }, 600);
    return () => clearTimeout(timer);
  }, [snap, showingSaved, botId, groupId]);

  // The safety snapshot is a gap detector, not the live path: SSE already carries
  // deltas. Stop the timer while the app is backgrounded; the stream effect resumes
  // from its cursor when the app returns.
  useFocusEffect(
    useCallback(() => {
      if (!foreground || (!botId && !groupId)) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ticking = false;
      const refreshDelay = () =>
        threadRefreshDelayMs(snap?.run?.status, {
          liveSubscribed: liveSubscribed.current,
          readOnly,
        });
      function schedule() {
        if (!cancelled) timer = setTimeout(() => void tick(), refreshDelay());
      }
      async function tick() {
        if (cancelled || ticking) return;
        ticking = true;
        let failure: unknown;
        try {
          if (!jumpScrollTarget.current && !expandedHistoryThread.current) {
            await refresh().catch((error: unknown) => {
              failure = error;
            });
          }
        } finally {
          ticking = false;
          if (isRetryableError(failure)) schedule();
        }
      }
      schedule();
      return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [botId, foreground, groupId, readOnly, snap?.run?.status]),
  );

  useEffect(() => {
    if (!botId && !groupId) return;
    // A conversation hit is the thread itself: stay on the live tail, not an older page.
    if (!messageId) {
      const pinned = pinnedAroundRef.current != null || jumpAnchor.current.holds();
      jumpAnchor.current.release();
      jumpScrollTarget.current = null;
      pinnedAroundRef.current = null;
      if (pinned) {
        expandedHistoryThread.current = null;
        commitSnap(snapRef.current);
      }
      return;
    }
    jumpAnchor.current.begin(messageId);
    void applyMessageJump(groupId ? { groupId, messageId } : { botId: botId!, messageId }).catch(
      (err) => {
        setError(errorText(err, t("Could not open message")));
      },
    );
  }, [botId, groupId, messageId, sessionEpoch]);

  return { isCurrentTarget, refresh, applyMessageJump, showLatest };
}
