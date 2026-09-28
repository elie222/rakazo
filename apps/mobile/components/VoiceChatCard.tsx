import type { VoiceChatGroup } from "@rakazo/core";
import { speechFromBlocks, voiceChatDuration, voiceChatSummary } from "@rakazo/core";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileMessage } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One call's exchange, collapsed to a card; expanding it shows the transcript. */
export function VoiceChatCard({ group }: { group: VoiceChatGroup<MobileMessage> }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const summary = voiceChatSummary(group);
  return (
    <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? t("Hide transcript") : t("Show transcript")}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((wasOpen) => !wasOpen)}
        style={styles.header}
      >
        <NativeSymbol ios="waveform" android="pulse-outline" size={16} color={tokens.foreground} />
        <Text style={[styles.title, { color: tokens.foreground }]}>{t("Voice chat")}</Text>
        <Text style={[styles.duration, { color: tokens.mutedForeground }]}>
          {clock(voiceChatDuration(group))}
        </Text>
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
            return message.role === "user" ? (
              <Text key={message.id} style={[styles.user, { color: tokens.mutedForeground }]}>
                {text}
              </Text>
            ) : (
              <Text
                key={message.id}
                style={[styles.bot, { backgroundColor: tokens.muted, color: tokens.foreground }]}
              >
                {text}
              </Text>
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
    borderWidth: StyleSheet.hairlineWidth,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, height: 40 },
  title: { fontSize: 15, fontWeight: "500" },
  duration: { fontSize: 13, fontVariant: ["tabular-nums"] },
  chevron: { marginStart: "auto", paddingStart: 8 },
  summary: { paddingHorizontal: 12, paddingBottom: 10, fontSize: 14, writingDirection: "auto" },
  transcript: { paddingHorizontal: 12, paddingBottom: 12, gap: 6 },
  user: { alignSelf: "flex-end", fontSize: 14, textAlign: "right", writingDirection: "auto" },
  bot: {
    fontSize: 14,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    overflow: "hidden",
    writingDirection: "auto",
  },
});
