import type { ReactNode, RefObject } from "react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CellRendererProps,
  FlatList,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from "react-native";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useI18n } from "../lib/i18n";
import type {
  InboxSignal,
  JumpDirection,
  JumpPill,
  RowLayout,
  VisibleRange,
} from "../lib/offscreen-unreads";
import {
  estimateRowLayout,
  jumpOffset,
  offscreenUnreads,
  PILL_GAP,
  visibleRange,
} from "../lib/offscreen-unreads";
import { UNREAD_JUMP_PILL_HEIGHT, UnreadJumpPill } from "./unread-jump-pill";

const entering = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const exiting = FadeOut.duration(160).reduceMotion(ReduceMotion.System);
/** How long a jump waits for the rows and content size around its target to settle again. */
const JUMP_SETTLE_MS = 600;
const JUMP_SETTLE_CAP_MS = 2000;

/**
 * Pills over the inbox that count unread chats scrolled out of view above and below, and
 * scroll to the nearest one. `signals` and `keys` follow the list's rows, keys as the list's
 * `keyExtractor` gives them. `topInset` and `bottomInset` are the parts of the list hidden
 * under the floating header and the home indicator.
 */
export function useUnreadJumpPills<Item>({
  signals,
  keys,
  listRef,
  topInset,
  bottomInset,
}: {
  signals: readonly InboxSignal[];
  keys: readonly string[];
  listRef: RefObject<FlatList<Item> | null>;
  topInset: number;
  bottomInset: number;
}) {
  const { t } = useI18n();
  // Measured rows by key, so a row keeps its layout when rows above it come or go.
  const layouts = useRef(new Map<string, RowLayout>());
  // A jump to a row not measured yet scrolls to an estimate, then lands once the row lays out.
  // It stays open briefly after that, because the list's content size is still an estimate
  // and the rows around it settle over the next frames.
  const pendingJump = useRef<{
    key: string;
    direction: JumpDirection;
    landedAt?: number;
    until?: number;
  } | null>(null);
  // At rest the list sits at its top inset: content y 0 shows just under the header.
  const scroll = useRef({ offset: -topInset, viewportHeight: 0, contentHeight: 0 });
  const [range, setRange] = useState<VisibleRange>();
  const hasMeasuredRows = useRef(false);
  const animateEntering = hasMeasuredRows.current;
  useLayoutEffect(() => {
    if (range) hasMeasuredRows.current = true;
  }, [range]);
  const count = signals.length;
  const keysRef = useRef(keys);
  keysRef.current = keys;

  const refresh = useCallback(() => {
    const { offset, viewportHeight } = scroll.current;
    if (viewportHeight === 0) return;
    const rows = keysRef.current.slice(0, count).map((key) => layouts.current.get(key));
    const next =
      offset < -topInset - 1
        ? undefined
        : visibleRange(rows, {
            top: offset + topInset,
            bottom: offset + viewportHeight - bottomInset,
          });
    setRange((current) =>
      current?.first === next?.first && current?.last === next?.last ? current : next,
    );
  }, [count, topInset, bottomInset]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // A row that moved in the list (a section collapsed or rows came in above it) drops its
  // layout: a rendered row reports its new one, and an unrendered one is estimated until then.
  const indexes = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    if (pendingJump.current && !keys.includes(pendingJump.current.key)) pendingJump.current = null;
    const next = new Map(keys.map((key, index) => [key, index]));
    for (const [key, index] of indexes.current) {
      if (next.get(key) !== index) layouts.current.delete(key);
    }
    indexes.current = next;
    refresh();
  }, [refresh, keys]);

  const scrollTo = (direction: JumpDirection, key: string, layout: RowLayout) => {
    const { viewportHeight, contentHeight } = scroll.current;
    // The list's content size is an estimate while rows below are unrendered and often runs
    // short, which would stop the jump early; the rows after the target give a floor for it.
    const rowsAfter = keysRef.current.length - 1 - keysRef.current.indexOf(key);
    const rowHeight = estimateRowLayout(
      keysRef.current.flatMap((rowKey) => {
        const row = layouts.current.get(rowKey);
        return row ? [row] : [];
      }),
      0,
    ).height;
    listRef.current?.scrollToOffset({
      offset: jumpOffset(direction, layout, {
        viewportHeight,
        contentHeight: Math.max(contentHeight, layout.y + layout.height + rowsAfter * rowHeight),
        topInset,
        bottomInset,
        pillSpace: PILL_GAP + UNREAD_JUMP_PILL_HEIGHT + PILL_GAP,
        isLast: key === keysRef.current[keysRef.current.length - 1],
      }),
    });
  };
  const finishJump = () => {
    const pending = pendingJump.current;
    const layout = pending && layouts.current.get(pending.key);
    if (!pending || !layout) return;
    const now = Date.now();
    pending.landedAt ??= now;
    if (pending.until !== undefined && now > pending.until) {
      pendingJump.current = null;
      return;
    }
    // Each correction waits a little longer for the next, up to a cap from the first landing.
    pending.until = Math.min(now + JUMP_SETTLE_MS, pending.landedAt + JUMP_SETTLE_CAP_MS);
    scrollTo(pending.direction, pending.key, layout);
  };
  const finishJumpRef = useRef(finishJump);
  finishJumpRef.current = finishJump;

  // Viewability does not subtract the floating header, safe area or landing pill space.
  // Replace FlatList's cell container to measure variable-height rows without extra wrappers.
  const CellRendererComponent = useMemo(
    () =>
      function InboxCell({ cellKey, onLayout, style, children }: CellRendererProps<Item>) {
        return (
          <View
            style={style}
            onLayout={(event) => {
              onLayout?.(event);
              const { y, height } = event.nativeEvent.layout;
              layouts.current.set(cellKey, { y, height });
              if (pendingJump.current?.key === cellKey) finishJumpRef.current();
              refreshRef.current();
            }}
          >
            {children}
          </View>
        );
      },
    [],
  );

  const listProps = useMemo(
    () => ({
      CellRendererComponent,
      scrollEventThrottle: 16,
      // The top of the list sits at a negative offset under the floating header; without this
      // a jump to the first rows stops at 0, behind the header.
      scrollToOverflowEnabled: true,
      // Scrolling by hand cancels a jump still waiting for its row.
      onScrollBeginDrag: () => {
        pendingJump.current = null;
      },
      onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
        scroll.current = {
          offset: contentOffset.y,
          viewportHeight: layoutMeasurement.height,
          contentHeight: contentSize.height,
        };
        refreshRef.current();
      },
      onLayout: (event: LayoutChangeEvent) => {
        scroll.current.viewportHeight = event.nativeEvent.layout.height;
        refreshRef.current();
      },
      onContentSizeChange: (_width: number, height: number) => {
        scroll.current.contentHeight = height;
        finishJumpRef.current();
        refreshRef.current();
      },
    }),
    [CellRendererComponent],
  );

  const pills = useMemo(() => (range ? offscreenUnreads(signals, range) : {}), [signals, range]);

  const jump = (direction: JumpDirection, pill: JumpPill) => {
    const key = keys[pill.index];
    if (key === undefined) return;
    const layout = layouts.current.get(key);
    if (layout) {
      pendingJump.current = null;
      scrollTo(direction, key, layout);
      return;
    }
    // Far rows aren't rendered yet: scroll to where the row should be so it renders, then
    // land on it exactly once it has laid out.
    pendingJump.current = { key, direction };
    scrollTo(
      direction,
      key,
      estimateRowLayout(
        keys.flatMap((rowKey) => {
          const row = layouts.current.get(rowKey);
          return row ? [row] : [];
        }),
        pill.index,
      ),
    );
  };

  const edge = (direction: JumpDirection, pill: JumpPill | undefined): ReactNode => {
    if (!pill) return null;
    const one = pill.count === 1;
    const label =
      pill.kind === "unread"
        ? one
          ? t("1 unread")
          : t("{count} unread", { count: pill.count })
        : one
          ? t("Needs attention")
          : t("{count} need attention", { count: pill.count });
    return (
      <Animated.View
        key={direction}
        testID={`home-unread-pill-${direction}`}
        pointerEvents="box-none"
        entering={animateEntering ? entering : undefined}
        exiting={exiting}
        style={[
          styles.edge,
          direction === "above" ? { top: topInset + PILL_GAP } : { bottom: bottomInset + PILL_GAP },
        ]}
      >
        <UnreadJumpPill
          direction={direction}
          label={label}
          accessibilityLabel={
            direction === "above" ? t("{label}, above", { label }) : t("{label}, below", { label })
          }
          onPress={() => jump(direction, pill)}
        />
      </Animated.View>
    );
  };

  return {
    listProps,
    overlay: (
      <>
        {edge("above", pills.above)}
        {edge("below", pills.below)}
      </>
    ),
  };
}

const styles = StyleSheet.create({
  edge: {
    position: "absolute",
    start: 0,
    end: 0,
    alignItems: "center",
  },
});
