import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ComposerMention } from "@rakazo/core";
import { mentionChipKey } from "@rakazo/core";
import type { Ref } from "react";
import type { ScrollViewInstance } from "react-native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useMobileTokens } from "../../lib/native/native";
import { BotAvatar } from "../bots/bot-avatar";
import { NativeSymbol } from "../native/native-symbol";

const MENTION_ROW_HEIGHT = 44;
const MENTION_ROW_PADDING = 14;
const MENTION_ROW_GAP = 12;
const MENTION_AVATAR_SIZE = 24;

export function ComposerMentionPicker({
  mentions,
  highlightedIndex,
  scrollRef,
  onRowLayout,
  onPick,
}: {
  mentions: ComposerMention[];
  highlightedIndex: number | null;
  scrollRef: Ref<ScrollViewInstance>;
  onRowLayout: (index: number, y: number) => void;
  onPick: (mention: ComposerMention) => void;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  return (
    <ScrollView
      ref={scrollRef}
      testID="mention-picker"
      keyboardShouldPersistTaps="handled"
      style={{
        flexGrow: 0,
        flexShrink: 1,
        marginTop: 12,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.card,
        overflow: "hidden",
      }}
    >
      {mentions.map((mention, index) => (
        <View
          key={mentionChipKey(mention)}
          onLayout={(event) => {
            onRowLayout(index, event.nativeEvent.layout.y);
          }}
        >
          {index > 0 ? (
            <View
              style={{
                height: 1,
                marginStart: MENTION_ROW_PADDING + MENTION_AVATAR_SIZE + MENTION_ROW_GAP,
                backgroundColor: tokens.border,
              }}
            />
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t`@${ph({ name: mention.name })}`}
            accessibilityState={{ selected: index === highlightedIndex }}
            onPress={() => onPick(mention)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: MENTION_ROW_GAP,
              minHeight: MENTION_ROW_HEIGHT,
              paddingHorizontal: MENTION_ROW_PADDING,
              backgroundColor: index === highlightedIndex ? tokens.muted : undefined,
            }}
          >
            <MentionOptionIcon mention={mention} />
            <Text
              numberOfLines={1}
              style={{ flexShrink: 1, color: tokens.foreground, fontSize: 17 }}
            >
              {mention.name}
            </Text>
            {mention.kind === "routine" || mention.kind === "connector" ? (
              <Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  textAlign: "right",
                  color: tokens.mutedForeground,
                  fontSize: 13,
                }}
              >
                {mention.subtitle}
              </Text>
            ) : null}
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  const tokens = useMobileTokens();
  if (mention.kind === "bot") {
    return (
      <BotAvatar
        color={mention.color ?? tokens.mutedForeground}
        avatarSet={mention.avatarSet}
        identity={mention.id}
        size={MENTION_AVATAR_SIZE}
      />
    );
  }
  const symbol =
    mention.kind === "routine"
      ? ({ ios: "clock", android: "time-outline" } as const)
      : mention.kind === "connector"
        ? ({ ios: "puzzlepiece.extension", android: "extension-puzzle-outline" } as const)
        : ({ ios: "person.3.fill", android: "people" } as const);
  return (
    <View
      style={{
        width: MENTION_AVATAR_SIZE,
        height: MENTION_AVATAR_SIZE,
        borderRadius: MENTION_AVATAR_SIZE / 2,
        backgroundColor: tokens.muted,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <NativeSymbol
        ios={symbol.ios}
        android={symbol.android}
        size={14}
        color={tokens.mutedForeground}
      />
    </View>
  );
}
