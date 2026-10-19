import { Divider, HStack, RNHostView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  background,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactElement } from "react";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";

export type InboxChatPreviewProps = {
  title: string;
  /** The last message as plain text, as the server stores it for the inbox row. */
  message?: string | null;
  avatar: ReactElement;
};

/** The card the system context menu lifts above an inbox row: the chat and its last message. */
export function InboxChatPreview({ title, message, avatar }: InboxChatPreviewProps) {
  const { t } = useI18n();
  const text = message?.trim() ?? "";
  return (
    <VStack
      alignment="leading"
      spacing={0}
      modifiers={[frame({ width: 320 }), background(native.page)]}
    >
      <HStack spacing={10} modifiers={[padding({ horizontal: 16, vertical: 12 })]}>
        <RNHostView matchContents>{avatar}</RNHostView>
        <Text modifiers={[font({ textStyle: "headline" }), lineLimit(1)]}>{title}</Text>
        <Spacer />
      </HStack>
      <Divider />
      {text ? (
        <Text
          modifiers={[
            lineLimit(8),
            padding({ horizontal: 12, vertical: 8 }),
            background(native.fill, shapes.roundedRectangle({ cornerRadius: 18 })),
            padding({ all: 16 }),
          ]}
        >
          {text}
        </Text>
      ) : (
        <Text
          modifiers={[
            foregroundStyle({ type: "hierarchical", style: "tertiary" }),
            padding({ all: 16 }),
          ]}
        >
          {t("No messages yet")}
        </Text>
      )}
    </VStack>
  );
}
