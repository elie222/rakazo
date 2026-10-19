import { unreadBoundaryId } from "@rakazo/core";
import { useRef } from "react";
import { Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";

/**
 * The message "New messages" sits above, fixed for the visit once live messages load, so
 * replies that arrive while reading do not move it.
 */
export function useUnreadBoundary(
  chat: string | undefined,
  openedUnread: boolean,
  messages: { id: string; role: string }[],
  live: boolean,
) {
  const boundary = useRef<{ chat?: string; id?: string | null }>({});
  if (boundary.current.chat !== chat) boundary.current = { chat };
  if (boundary.current.id === undefined && messages.length > 0 && live) {
    boundary.current.id = openedUnread ? unreadBoundaryId(messages) : null;
  }
  return boundary.current.id ?? null;
}

export function UnreadSeparator() {
  const { t } = useI18n();
  const { border, mutedForeground } = mobileTokens();
  return (
    <View
      accessibilityRole="header"
      style={{ flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 12 }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: border }} />
      <Text selectable={false} style={{ color: mutedForeground, fontSize: 12 }}>
        {t("New messages")}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: border }} />
    </View>
  );
}
