import { appendNewerThreadPage, forwardProbeAfterPage, threadWindowMessages } from "@rakazo/core";
import { useState } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import type { MobileMessage, MobileSnapshot } from "./api";
import { prependMobileMessagePage, rpc } from "./api";
import { useI18n } from "./i18n";
import type { ThreadHistory } from "./thread-history";
import type { ThreadListScroll } from "./thread-list-scroll";
import { errorText } from "./user-error";

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

function pinnedDistanceFromEnd(event: ScrollEvent) {
  const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
  return contentSize.height - layoutMeasurement.height - contentOffset.y;
}

/**
 * Loads earlier messages above the chat, and newer pages below a pinned page until it reaches the
 * latest message and rejoins the live thread.
 */
export function useThreadPaging({
  history,
  scroll,
  botId,
  groupId,
  visibleMessages,
  anchor,
  setError,
  showLatest,
}: {
  history: ThreadHistory;
  scroll: ThreadListScroll;
  botId?: string;
  groupId?: string;
  visibleMessages: MobileMessage[];
  /** Where a jump target settles below the header. */
  anchor: number;
  setError: (error: string | null) => void;
  showLatest: () => void;
}) {
  const { t } = useI18n();
  const {
    snap,
    commitSnap,
    snapRef,
    expandedHistoryThread,
    historyEpoch,
    pinnedAroundRef,
    jumpScrollTarget,
    jumpAnchor,
    joinPinnedAfterLayout,
    newerLoadFailed,
    pinnedScrollMetrics,
    loadingOlderContent,
    loadingNewerContent,
  } = history;
  const { pinnedNewerCursor, pinnedScrollBack } = scroll;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);

  async function loadNewerMessages() {
    const pinned = pinnedAroundRef.current;
    if (
      (!botId && !groupId) ||
      pinned?.newerCursor == null ||
      loadingNewerContent.current ||
      newerLoadFailed.current
    )
      return;
    loadingNewerContent.current = true;
    setLoadingNewer(true);
    const epoch = historyEpoch.current;
    const probe = pinned.probeSeq ?? pinned.newerCursor + 1;
    let visibleUnchanged = false;
    try {
      // Pages come back centered on the seq, so the one after the cursor overlaps what is loaded.
      const page = await rpc("threads/messages", {
        ...(groupId ? { groupId } : { botId: botId! }),
        around: { seq: probe },
      });
      if (epoch !== historyEpoch.current || pinnedAroundRef.current !== pinned || !snapRef.current)
        return;
      const visibleBefore = threadWindowMessages(
        snapRef.current.messages,
        pinned.newerCursor,
      ).length;
      const reported = page.coveredThroughSeq ?? null;
      const carried =
        reported == null ? undefined : Math.max(pinned.coveredThroughSeq ?? reported, reported);
      const next = appendNewerThreadPage<MobileMessage, MobileSnapshot>(
        snapRef.current,
        pinned.newerCursor,
        page,
        reported == null ? null : carried,
      );
      const step = forwardProbeAfterPage({
        probe,
        newerCursor: pinned.newerCursor,
        nextCursor: next.newerCursor,
        reportedCoverage: reported,
        carriedCoverage: pinned.coveredThroughSeq,
      });
      if (step.stalled) newerLoadFailed.current = true;
      visibleUnchanged =
        threadWindowMessages(next.snapshot.messages, next.newerCursor).length === visibleBefore;
      pinnedAroundRef.current = {
        ...pinned,
        newerCursor: next.newerCursor,
        coveredThroughSeq: step.coverage,
        probeSeq: step.probe,
      };
      commitSnap(next.snapshot);
      if (next.newerCursor == null) {
        joinPinnedAfterLayout.current = pinnedScrollMetrics.current.content;
      }
    } catch (err) {
      if (epoch !== historyEpoch.current || pinnedAroundRef.current !== pinned) return;
      newerLoadFailed.current = true;
      setError(errorText(err, t("Could not open message")));
    } finally {
      loadingNewerContent.current = false;
      setLoadingNewer(false);
      if (visibleUnchanged) loadNewerNearEnd();
    }
  }

  async function loadOlderMessages() {
    if ((!botId && !groupId) || snap?.olderCursor == null || loadingOlder) return;
    loadingOlderContent.current = true;
    setLoadingOlder(true);
    const epoch = historyEpoch.current;
    const pinned = pinnedAroundRef.current;
    try {
      const page = await rpc("threads/messages", {
        ...(groupId ? { groupId } : { botId: botId! }),
        before: snap.olderCursor,
        includePeerReceipts: true,
      });
      if (epoch !== historyEpoch.current || pinnedAroundRef.current !== pinned) {
        loadingOlderContent.current = false;
        return;
      }
      expandedHistoryThread.current = page.threadId;
      commitSnap(prependMobileMessagePage(snapRef.current, page));
    } catch (err) {
      loadingOlderContent.current = false;
      if (epoch !== historyEpoch.current || pinnedAroundRef.current !== pinned) return;
      setError(errorText(err, t("Could not load earlier messages")));
    } finally {
      setLoadingOlder(false);
    }
  }

  function loadNewerNearEnd() {
    // Wait until the matched row has a real offset. Prefetching from the top
    // of the page changes the content size and lands back on an older reply.
    // A hit that is not drawn (filtered out of the transcript) must not hold
    // that wait, or newer pages never load.
    const targetId = jumpScrollTarget.current ?? pinnedAroundRef.current?.messageId;
    const targetDrawn =
      targetId != null &&
      threadWindowMessages(visibleMessages, pinnedNewerCursor).some(
        (message) => message.id === targetId,
      );
    if (jumpAnchor.current.holds() && !targetDrawn) {
      jumpAnchor.current.release();
      jumpScrollTarget.current = null;
    } else if (jumpAnchor.current.blocksPaging(targetDrawn, anchor)) {
      return;
    }
    const { offset, viewport, content } = pinnedScrollMetrics.current;
    // Fetch the next page while a screen of this one is still left to read; a page shorter
    // than the screen never scrolls, so layout and content changes check too.
    if (viewport > 0 && content - viewport - offset < viewport) void loadNewerMessages();
  }

  function updatePinnedScroll(event: ScrollEvent) {
    // Once the page reaches the latest message, the end of it is the live thread.
    if (
      pinnedNewerCursor === null &&
      !jumpScrollTarget.current &&
      pinnedDistanceFromEnd(event) <= 80
    ) {
      showLatest();
    }
  }

  const pinnedListHandlers = {
    onLayout: (event: LayoutChangeEvent) => {
      pinnedScrollMetrics.current.viewport = event.nativeEvent.layout.height;
      loadNewerNearEnd();
    },
    onContentSizeChange: (_width: number, height: number) => {
      pinnedScrollMetrics.current.content = height;
      if (scroll.correctHelperResize()) return;
      const jumpOffset = jumpAnchor.current.align(anchor);
      if (jumpOffset != null) scroll.scrollPinnedTo(jumpOffset);
      const armedAt = joinPinnedAfterLayout.current;
      if (armedAt != null && height !== armedAt) {
        joinPinnedAfterLayout.current = null;
        if (
          !jumpAnchor.current.holds() &&
          pinnedAroundRef.current?.newerCursor == null &&
          scroll.pinnedNearEnd()
        ) {
          showLatest();
          return;
        }
      }
      loadNewerNearEnd();
    },
    onScroll: (event: ScrollEvent) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      pinnedScrollMetrics.current = {
        offset: contentOffset.y,
        viewport: layoutMeasurement.height,
        content: contentSize.height,
      };
      scroll.dismissKeyboardOnScrollBack(pinnedScrollBack.current, event);
      loadNewerNearEnd();
    },
    onScrollBeginDrag: (event: ScrollEvent) => {
      pinnedScrollBack.current.onDragStart(event.nativeEvent);
      newerLoadFailed.current = false;
      if (!jumpAnchor.current.holds()) return;
      jumpAnchor.current.release();
      jumpScrollTarget.current = null;
    },
    onScrollEndDrag: (event: ScrollEvent) => {
      pinnedScrollBack.current.onDragEnd();
      updatePinnedScroll(event);
    },
    onMomentumScrollEnd: updatePinnedScroll,
  };

  return { loadingOlder, loadingNewer, loadOlderMessages, pinnedListHandlers };
}
