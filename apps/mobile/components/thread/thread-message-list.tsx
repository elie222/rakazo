import type { ThreadItem } from "@rakazo/core";
import { threadWindowMessages } from "@rakazo/core";
import type { ReactElement, ReactNode } from "react";
import { useMemo } from "react";
import type { ListRenderItem } from "react-native";
import {
  ActivityIndicator,
  FlatList,
  I18nManager,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import type { MobileMessage } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { threadColumnTrailingInset } from "../../lib/thread-edges";
import type { ThreadListScroll } from "../../lib/thread-list-scroll";
import type { useThreadPaging } from "../../lib/thread-paging";
import { ThreadScrollSurface } from "../thread-scroll-surface";
import { JumpToLatestButton } from "./thread-list-controls";

const styles = StyleSheet.create({
  // Full screen width. Column padding stays on the content so the indicator
  // is drawn on the screen edge rather than inside the column.
  list: { flex: 1 },
});
const messageListPosition = { minIndexForVisible: 0 };
const liveMessageListPosition = { ...messageListPosition, autoscrollToTopThreshold: 80 };
function threadItemKey(item: ThreadItem<MobileMessage>) {
  return item.kind === "voiceChat" ? item.key : item.message.id;
}

/**
 * The chat's messages: the inverted live list, or the pinned page a search jump opened, with the
 * jump to latest button over either.
 */
export function ThreadMessageList({
  scroll,
  pinnedListHandlers,
  threadKey,
  headerClearance,
  bottomInset,
  columnPadding,
  visibleMessages,
  liveItems,
  renderItem,
  renderMessageRow,
  loadEarlierControl,
  failedSendBubbles,
  errorNotice,
  workingFooter,
  loadingNewer,
  showLatest,
}: {
  scroll: ThreadListScroll;
  pinnedListHandlers: ReturnType<typeof useThreadPaging>["pinnedListHandlers"];
  threadKey: string | undefined;
  headerClearance: { padding: number; minHeight: number };
  /** Space under the list that the composer does not cover. */
  bottomInset: number;
  /** Message inset. Applied to the content, never the scroll view frame. */
  columnPadding: { paddingLeft: number; paddingRight: number };
  visibleMessages: MobileMessage[];
  liveItems: ThreadItem<MobileMessage>[];
  renderItem: ListRenderItem<ThreadItem<MobileMessage>>;
  renderMessageRow: (
    message: MobileMessage,
    options?: { enableJump?: boolean; index?: number },
  ) => ReactElement;
  loadEarlierControl: ReactElement | null;
  failedSendBubbles: ReactNode;
  errorNotice: ReactNode;
  workingFooter: ReactNode;
  loadingNewer: boolean;
  showLatest: () => void;
}) {
  const tokens = mobileTokens();
  const { showPinnedPage, pinnedTarget, pinnedNewerCursor, behavior, state } = scroll;
  const { jumpTarget } = scroll;
  const listContentStyle = useMemo(
    () => ({
      paddingBottom: headerClearance.padding,
      paddingTop: bottomInset + 16,
      ...columnPadding,
    }),
    [headerClearance.padding, bottomInset, columnPadding],
  );
  const jumpInset = threadColumnTrailingInset(columnPadding, I18nManager.isRTL);

  return (
    // The floor keeps a tall suggestion list from sliding under the transparent header.
    <View
      ref={scroll.helperViewport}
      collapsable={false}
      style={{ flex: 1, minHeight: headerClearance.minHeight, position: "relative" }}
    >
      {showPinnedPage ? (
        <ThreadScrollSurface key={`pinned:${jumpTarget ?? pinnedTarget?.messageId ?? threadKey}`}>
          <ScrollView
            key={jumpTarget ?? pinnedTarget?.messageId ?? threadKey}
            ref={scroll.pinnedList}
            style={styles.list}
            // A pinned page always shows the floating jump button (44pt, 12pt from the
            // bottom), so its last message must be able to scroll clear of it.
            contentContainerStyle={{
              paddingTop: headerClearance.padding,
              paddingBottom: 12 + 44 + 16,
              ...columnPadding,
            }}
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            maintainVisibleContentPosition={messageListPosition}
            scrollEventThrottle={16}
            {...pinnedListHandlers}
          >
            {loadEarlierControl}
            {threadWindowMessages(visibleMessages, pinnedNewerCursor).map((message, index) =>
              renderMessageRow(message, { enableJump: true, index }),
            )}
            {pinnedNewerCursor === null ? failedSendBubbles : null}
            {errorNotice}
            {pinnedNewerCursor === null ? (
              workingFooter
            ) : loadingNewer ? (
              <ActivityIndicator color={tokens.mutedForeground} style={{ marginVertical: 12 }} />
            ) : null}
          </ScrollView>
        </ThreadScrollSurface>
      ) : (
        <ThreadScrollSurface key={`live:${threadKey}`}>
          <FlatList
            key={threadKey}
            ref={scroll.list}
            data={liveItems}
            inverted
            keyExtractor={threadItemKey}
            // This callback tracks every row input, including reply, reaction and highlight state.
            extraData={renderMessageRow}
            style={styles.list}
            // Swiping down hides the keyboard; on iOS it follows the finger.
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            // Inverted, so the bottom padding is the visual top, clear of the transparent header.
            contentContainerStyle={listContentStyle}
            // Follow changes to the recovery card while already at the newest content.
            maintainVisibleContentPosition={liveMessageListPosition}
            scrollEventThrottle={16}
            {...scroll.liveListHandlers}
            ListFooterComponent={loadEarlierControl}
            ListHeaderComponent={
              <View onLayout={() => scroll.performScroll(behavior.current.onLayout())}>
                {errorNotice}
                {failedSendBubbles}
                {workingFooter}
              </View>
            }
            renderItem={renderItem}
          />
        </ThreadScrollSurface>
      )}
      {showPinnedPage || state.detached ? (
        <JumpToLatestButton
          insetEnd={jumpInset}
          unread={state.unread}
          onPress={() => {
            if (showPinnedPage) {
              showLatest();
              return;
            }
            scroll.follow(behavior.current.jumpToLatest());
          }}
        />
      ) : null}
    </View>
  );
}
