import type { ThreadItem } from "@rakazo/core";
import { reconcileThreadScrollState } from "@rakazo/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  FlatList,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  View,
} from "react-native";
import { Platform } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { useReducedMotion } from "react-native-reanimated";
import type { MobileMessage } from "./api";
import { helperHeaderOffset, helperOpenTarget } from "./helper-header-offset";
import { KeyboardScrollBack } from "./keyboard-scroll-back";
import type { ThreadHistory } from "./thread-history";
import type { ThreadRowKey, ThreadScrollAction, ThreadScrollState } from "./thread-scroll";
import { ThreadScrollBehavior } from "./thread-scroll";

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;
type HelperMeasure = (done: (y: number, cardBottom: number) => void) => void;

/**
 * Scrolling for the chat's two lists: the inverted live list that follows new messages, and the
 * pinned page a search jump opens. Owns follow and detach state, helper card corrections and the
 * jump target's alignment and highlight.
 */
export function useThreadListScroll({
  history,
  threadKey,
  botId,
  groupId,
  anchor,
  visibleBottomInset,
  latestRowKey,
}: {
  history: ThreadHistory;
  threadKey: string | undefined;
  botId?: string;
  groupId?: string;
  /** Where a jump target and an opened helper settle below the header. */
  anchor: number;
  /** Space under the list that the composer does not cover. */
  visibleBottomInset: number;
  latestRowKey: ThreadRowKey;
}) {
  const {
    snap,
    expandedHistoryThread,
    pinnedAroundRef,
    jumpScrollTarget,
    jumpAnchor,
    joinPinnedAfterLayout,
    loadingOlderContent,
    pinnedScrollMetrics,
  } = history;
  const list = useRef<FlatList<ThreadItem<MobileMessage>>>(null);
  const pinnedList = useRef<ScrollView>(null);
  const helperViewport = useRef<View>(null);
  const helperScrollOffset = useRef(0);
  const helperResize = useRef<(() => void) | null>(null);
  const behavior = useRef(new ThreadScrollBehavior());
  const liveScrollBack = useRef(new KeyboardScrollBack({ inverted: true }));
  const pinnedScrollBack = useRef(new KeyboardScrollBack({ inverted: false }));
  const scrollIdleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nativeMomentumActive = useRef(false);
  const reducedMotion = useReducedMotion();
  const [state, setState] = useState<ThreadScrollState>(() => behavior.current.state());
  const publish = useCallback((next: ThreadScrollState) => {
    setState((previous) => reconcileThreadScrollState(previous, next));
  }, []);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    behavior.current.openThread(threadKey ?? "");
    expandedHistoryThread.current = null;
    pinnedAroundRef.current = null;
    jumpScrollTarget.current = null;
    jumpAnchor.current.release();
    joinPinnedAfterLayout.current = null;
    loadingOlderContent.current = false;
    publish(behavior.current.state());
    return () => {
      clearTimeout(scrollIdleTimer.current);
      nativeMomentumActive.current = false;
    };
  }, [threadKey, publish]);

  useEffect(() => {
    publish(behavior.current.state());
  }, [threadKey, publish]);

  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    [],
  );

  const pinnedTarget = pinnedAroundRef.current;
  const showPinnedPage = Boolean(
    jumpScrollTarget.current ||
      (pinnedTarget &&
        ((pinnedTarget.botId && pinnedTarget.botId === botId) ||
          (pinnedTarget.groupId && pinnedTarget.groupId === groupId))),
  );
  const pinnedNewerCursor = showPinnedPage ? (pinnedTarget?.newerCursor ?? null) : null;

  function performScroll(action: ThreadScrollAction) {
    if (!action || showPinnedPage) return;
    behavior.current.onProgrammaticScroll();
    list.current?.scrollToOffset({
      offset: 0,
      animated: action === "smooth" && !reducedMotion,
    });
  }

  /** Runs a scroll behavior step, then publishes the state it leaves. */
  function follow(action: ThreadScrollAction) {
    performScroll(action);
    publish(behavior.current.state());
  }

  function pinnedNearEnd() {
    const { offset, viewport, content } = pinnedScrollMetrics.current;
    return viewport > 0 && content - viewport - offset <= 80;
  }

  function scrollPinnedTo(offset: number) {
    pinnedList.current?.scrollTo({ y: offset, animated: false });
    pinnedScrollMetrics.current.offset = offset;
  }

  function scheduleScrollIdle() {
    clearTimeout(scrollIdleTimer.current);
    // Every scroll event renews the fallback. Native momentum gets a longer
    // grace period, but a missing momentum-end must still recover after silence.
    scrollIdleTimer.current = setTimeout(
      () => {
        nativeMomentumActive.current = false;
        follow(behavior.current.onUserMomentumEnd());
      },
      nativeMomentumActive.current ? 1000 : 200,
    );
  }

  function trackUserScroll(offset: number) {
    const previous = behavior.current.state();
    const next = behavior.current.onUserScroll(offset);
    if (reconcileThreadScrollState(previous, next) !== previous) publish(next);
  }

  function updateUserScroll(event: ScrollEvent) {
    // Inverted FlatList: contentOffset.y is distance from the latest messages.
    scheduleScrollIdle();
    trackUserScroll(event.nativeEvent.contentOffset.y);
  }

  /** Keeps an opened or closed helper card's header where it was tapped. */
  function helperToggle(measure: HelperMeasure, toggle: () => void, opening: boolean) {
    if (Platform.OS !== "ios") {
      toggle();
      return;
    }
    measure((before) => {
      const correct = () => {
        requestAnimationFrame(() =>
          measure((after, cardBottom) => {
            helperViewport.current?.measureInWindow((_x, y, _width, height) => {
              const target = opening
                ? helperOpenTarget({
                    headerY: before,
                    cardBottom: cardBottom + before - after,
                    topLimit: anchor,
                    visibleBottom: y + height - visibleBottomInset,
                  })
                : before;
              if (showPinnedPage) {
                pinnedList.current?.scrollTo({
                  y: helperHeaderOffset(pinnedScrollMetrics.current.offset, after, target),
                  animated: false,
                });
              } else {
                const offset = helperHeaderOffset(helperScrollOffset.current, target, after);
                list.current?.scrollToOffset({ offset, animated: false });
                // The settled list ignores this scroll's event, so record where it now sits.
                helperScrollOffset.current = offset;
                trackUserScroll(offset);
              }
            });
          }),
        );
      };
      helperResize.current = correct;
      toggle();
      // A helper without a body may not change the list's content size.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (helperResize.current === correct) {
            helperResize.current = null;
            correct();
          }
        }),
      );
    });
  }

  /** Runs a pending helper correction for a content size change; true when one ran. */
  function correctHelperResize(onCorrect?: () => void) {
    const correctHelper = helperResize.current;
    if (!correctHelper) return false;
    helperResize.current = null;
    onCorrect?.();
    correctHelper();
    return true;
  }

  /** Scrolls a pinned page to its jump target once that row is laid out, and highlights it. */
  function layoutJumpRow(messageId: string, y: number, index: number) {
    const offset = jumpAnchor.current.onMessageLayout(messageId, y, index, anchor);
    if (offset == null) return;
    scrollPinnedTo(offset);
    setHighlightedMessageId(messageId);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedMessageId(null), 1200);
    requestAnimationFrame(() => {
      const again = jumpAnchor.current.align(anchor);
      if (again != null) scrollPinnedTo(again);
    });
  }

  function dismissKeyboardOnScrollBack(scrollBack: KeyboardScrollBack, event: ScrollEvent) {
    if (scrollBack.onScroll(event.nativeEvent) && Platform.OS === "ios") {
      KeyboardController.dismiss();
    }
  }

  const liveListHandlers = {
    onScrollBeginDrag: (event: ScrollEvent) => {
      clearTimeout(scrollIdleTimer.current);
      nativeMomentumActive.current = false;
      behavior.current.onUserDragStart();
      liveScrollBack.current.onDragStart(event.nativeEvent);
    },
    onScroll: (event: ScrollEvent) => {
      helperScrollOffset.current = event.nativeEvent.contentOffset.y;
      dismissKeyboardOnScrollBack(liveScrollBack.current, event);
      if (behavior.current.isTrackingUserScroll()) updateUserScroll(event);
    },
    // Keep tracking after release: a fling can cross the threshold mid-momentum.
    onScrollEndDrag: (event: ScrollEvent) => {
      if (behavior.current.isTrackingUserScroll()) updateUserScroll(event);
      behavior.current.onUserDragEnd();
      liveScrollBack.current.onDragEnd();
      scheduleScrollIdle();
    },
    onMomentumScrollBegin: () => {
      nativeMomentumActive.current = true;
      scheduleScrollIdle();
    },
    onMomentumScrollEnd: (event: ScrollEvent) => {
      nativeMomentumActive.current = false;
      if (behavior.current.isTrackingUserScroll()) updateUserScroll(event);
      clearTimeout(scrollIdleTimer.current);
      follow(behavior.current.onUserMomentumEnd());
    },
    onLayout: (event: LayoutChangeEvent) => {
      follow(behavior.current.onLayout(event.nativeEvent.layout.height));
    },
    onContentSizeChange: (_width: number, height: number) => {
      if (correctHelperResize(() => publish(behavior.current.onContentSizeChanged(height)))) {
        return;
      }
      publish(behavior.current.onContentSizeChanged(height));
      if (loadingOlderContent.current) {
        loadingOlderContent.current = false;
        return;
      }
      const blocked = Boolean(
        jumpScrollTarget.current ||
          (pinnedAroundRef.current &&
            ((pinnedAroundRef.current.botId && pinnedAroundRef.current.botId === botId) ||
              (pinnedAroundRef.current.groupId && pinnedAroundRef.current.groupId === groupId))) ||
          expandedHistoryThread.current === snap?.threadId,
      );
      follow(behavior.current.onContentChanged(blocked, latestRowKey));
    },
  };

  return {
    list,
    pinnedList,
    helperViewport,
    behavior,
    pinnedScrollBack,
    state,
    setState,
    publish,
    showPinnedPage,
    jumpTarget: jumpScrollTarget.current,
    pinnedTarget,
    pinnedNewerCursor,
    highlightedMessageId,
    performScroll,
    follow,
    pinnedNearEnd,
    scrollPinnedTo,
    helperToggle,
    correctHelperResize,
    layoutJumpRow,
    dismissKeyboardOnScrollBack,
    liveListHandlers,
  };
}

export type ThreadListScroll = ReturnType<typeof useThreadListScroll>;
