import { useLingui } from "@lingui/react/macro";
import type { VoiceChatGroup } from "@rakazo/core";
import { speechFromBlocks, voiceChatDuration, voiceChatSummary } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { Fragment, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileMessage } from "../../lib/api/mobile-types";
import { canSelectMessage } from "../../lib/messages/message-selection";
import { native, useMobileTokens } from "../../lib/native/native";
import { NativeSymbol } from "../native/native-symbol";

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One call's exchange, collapsed to a card; expanding it shows the transcript. */
export function VoiceChatCard({
  group,
  selectedIds = null,
  onToggleSelection,
  onStartSelection,
}: {
  group: VoiceChatGroup<MobileMessage>;
  /** The messages chosen to copy together; null while not choosing. */
  selectedIds?: ReadonlySet<string> | null;
  onToggleSelection?: (message: MobileMessage) => void;
  /** Long-pressing a turn starts choosing, as a message's menu does elsewhere. */
  onStartSelection?: (message: MobileMessage) => void;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  // The list remounts cards scrolled out of view; one holding chosen turns comes back open.
  const [open, setOpen] = useState(() =>
    group.messages.some((message) => selectedIds?.has(message.id)),
  );
  const summary = voiceChatSummary(group);
  const title = t`Voice chat`;
  const duration = clock(voiceChatDuration(group));
  return (
    <View style={[styles.card, { backgroundColor: native.fill }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          open
            ? t`Hide transcript: ${title}, ${duration}`
            : t`Show transcript: ${title}, ${duration}`
        }
        accessibilityState={{ expanded: open }}
        onPress={() => {
          // Turns that are no longer shown must not stay chosen for the copy.
          if (open && selectedIds && onToggleSelection) {
            for (const message of group.messages) {
              if (selectedIds.has(message.id)) onToggleSelection(message);
            }
          }
          setOpen((wasOpen) => !wasOpen);
        }}
        style={styles.header}
      >
        <NativeSymbol ios="waveform" android="pulse-outline" size={16} color={tokens.foreground} />
        <Text style={[styles.title, { color: tokens.foreground }]}>{title}</Text>
        <Text style={[styles.duration, { color: tokens.mutedForeground }]}>{duration}</Text>
        <View style={styles.chevron}>
          <NativeSymbol
            ios={open ? "chevron.up" : "chevron.down"}
            android={open ? "chevron-up" : "chevron-down"}
            size={16}
            color={tokens.mutedForeground}
          />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.transcript}>
          {group.messages.map((message) => {
            // The marker is the card's summary line, never a transcript turn.
            if (message === group.marker) return null;
            const text = speechFromBlocks(message.blocks).trim();
            if (!text) return null;
            const turn =
              message.role === "user" ? (
                <Text style={[styles.user, { color: tokens.mutedForeground }]}>{text}</Text>
              ) : (
                <Text
                  style={[
                    styles.bot,
                    { backgroundColor: native.fillPressed, color: tokens.foreground },
                  ]}
                >
                  {text}
                </Text>
              );
            if (!selectedIds && onStartSelection && canSelectMessage(message)) {
              return (
                <Pressable
                  key={message.id}
                  accessibilityActions={[{ name: "selectMessages", label: t`Select messages` }]}
                  onAccessibilityAction={(event) => {
                    if (event.nativeEvent.actionName === "selectMessages")
                      onStartSelection(message);
                  }}
                  onLongPress={() => onStartSelection(message)}
                >
                  {turn}
                </Pressable>
              );
            }
            if (!selectedIds || !onToggleSelection || !canSelectMessage(message)) {
              return <Fragment key={message.id}>{turn}</Fragment>;
            }
            const selected = selectedIds.has(message.id);
            return (
              <Pressable
                key={message.id}
                accessibilityRole="checkbox"
                accessibilityLabel={text}
                accessibilityState={{ checked: selected }}
                onPress={() => onToggleSelection(message)}
                style={styles.choosable}
              >
                <NativeSymbol
                  ios={selected ? "checkmark.circle.fill" : "circle"}
                  android={selected ? "checkmark-circle" : "ellipse-outline"}
                  size={22}
                  color={selected ? tokens.primary : tokens.mutedForeground}
                />
                <View style={styles.choosableTurn} pointerEvents="none">
                  {turn}
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : summary ? (
        <Text numberOfLines={1} style={[styles.summary, { color: tokens.mutedForeground }]}>
          {summary}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: "flex-start",
    maxWidth: "88%",
    borderRadius: 18,
  },
  // 40 tall around the 22 pt title line, growing with it at larger text sizes.
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    minHeight: 40,
  },
  title: typeScale.cardTitle,
  duration: { ...typeScale.caption, fontVariant: ["tabular-nums"] },
  chevron: { marginStart: "auto", paddingStart: 8 },
  summary: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    ...typeScale.secondary,
    writingDirection: "auto",
  },
  transcript: { paddingHorizontal: 12, paddingBottom: 12, gap: 6 },
  choosable: { flexDirection: "row", alignItems: "center", gap: 8 },
  choosableTurn: { flex: 1 },
  user: {
    alignSelf: "flex-end",
    ...typeScale.secondary,
    textAlign: "right",
    writingDirection: "auto",
  },
  bot: {
    ...typeScale.secondary,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    overflow: "hidden",
    writingDirection: "auto",
  },
});
