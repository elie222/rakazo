import { t } from "@lingui/core/macro";
import type { ImperativeRouter, NativeStackNavigationOptions } from "expo-router";
import { Pressable } from "react-native";
import { mobileTokens } from "../../../lib/appearance/appearance";
import { setInboxHidden } from "../../../lib/layout/split-view";
import { iosAtLeast } from "../../../lib/native/native-controls";
import { threadEdgeOptions } from "../../../lib/thread/scroll/thread-edges";
import { NativeSymbol } from "../../native/native-symbol";
import { trailingHeaderOptions } from "../../native/sheet-header";
import type { ChatTitleParams } from "./chat-header-title";
import { ChatHeaderTitle } from "./chat-header-title";
import { openInvite, threadHeaderRight } from "./thread-header-right";

/**
 * Whether the chat sits beside the chat list, whether that list is hidden, and whether a
 * book-like fold keeps the list beside the chat.
 */
export type ChatSplit = { split: boolean; inboxHidden: boolean; foldActive?: boolean };

/**
 * A chat's whole header as its route declares it when the screen is created, before the chat
 * has rendered: the title capsule, the right-side button and, beside the chat list, the
 * sidebar button. Everything is in the first native header, so the title sits at its final
 * place from the first frame of the push and is never re-laid out. The open chat feeds the
 * title its data without changing the buttons' shape.
 */
export function chatRouteHeader(
  route: { key?: string; params?: object },
  { split, inboxHidden, foldActive }: ChatSplit,
  router: ImperativeRouter,
  canInvite = false,
): NativeStackNavigationOptions {
  const params = (route.params ?? {}) as ChatTitleParams;
  const { groupId, botId } = params;
  const readOnly = params.readOnly === "1";
  const color = mobileTokens().foreground;
  return {
    headerTitleAlign: "center",
    ...threadEdgeOptions(),
    headerTitle: () => <ChatHeaderTitle routeKey={route.key ?? ""} params={params} />,
    ...threadHeaderRight({
      inGroup: Boolean(groupId),
      readOnly,
      color,
      onGroupSettings: () =>
        router.push({ pathname: "/group-settings", params: { groupId: groupId ?? "" } }),
      onInvite: canInvite && botId ? () => openInvite(router) : undefined,
    }),
    ...threadHeaderLeft({ split, inboxHidden, foldActive, color }),
    // An archived chat offers Restore; the open chat gives it its action.
    ...(readOnly ? trailingHeaderOptions(t`Restore`, () => undefined) : {}),
  };
}

/**
 * Beside the chat list, the list carries its own hide button; once hidden, the chat's left
 * button brings it back instead of going back.
 */
export function threadHeaderLeft({
  split,
  inboxHidden,
  foldActive,
  color,
}: ChatSplit & { color: string }): NativeStackNavigationOptions {
  if (!split || foldActive || !inboxHidden) {
    // Folding back takes the list away, so the chat gets its back button again. Folded like
    // a book, or with the list on show, the chat needs neither.
    return {
      headerBackVisible: !split,
      headerLeft: undefined,
      ...(iosAtLeast(26) ? { unstable_headerLeftItems: () => [] } : {}),
    };
  }
  const label = t`Show chats`;
  return {
    headerBackVisible: false,
    ...(iosAtLeast(26)
      ? {
          unstable_headerLeftItems: () => [
            {
              type: "button" as const,
              label,
              icon: { type: "sfSymbol" as const, name: "sidebar.left" },
              onPress: () => setInboxHidden(false),
            },
          ],
        }
      : {}),
    headerLeft: () => <ShowChatsButton color={color} />,
  };
}

/** Brings the hidden chat list back. */
export function ShowChatsButton({ color }: { color?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t`Show chats`}
      hitSlop={8}
      onPress={() => setInboxHidden(false)}
    >
      <NativeSymbol ios="sidebar.left" android="contract-outline" size={21} color={color} />
    </Pressable>
  );
}
