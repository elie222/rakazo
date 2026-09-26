import { useRouter } from "expo-router";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileMe } from "../lib/api";
import { rpc } from "../lib/api";
import type { CallPhase } from "../lib/call-session";
import { endCall, toggleMute, toggleTranscript, useCallSession } from "../lib/call-session";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { NativeSymbol } from "./native-symbol";

const BARS = [9, 15, 21, 15, 9];
const TRANSCRIPT_LINES = 4;

let cachedInitial: string | null = null;

export function CallCard() {
  const call = useCallSession();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [initial, setInitial] = useState(cachedInitial ?? "");
  const onCall = Boolean(call);

  useEffect(() => {
    if (!onCall || cachedInitial !== null) return;
    void rpc<MobileMe>("me")
      .then((me) => {
        cachedInitial = (me.name ?? me.email ?? "").trim().slice(0, 1).toUpperCase();
        setInitial(cachedInitial);
      })
      .catch(() => undefined);
  }, [onCall]);

  if (!call) return null;
  return (
    <View
      style={[
        styles.card,
        {
          top: insets.top + 52,
          backgroundColor: tokens.card,
          borderColor: tokens.border,
          shadowColor: tokens.foreground,
        },
      ]}
    >
      <View style={styles.row}>
        <BotAvatar color={call.botColor} identity={call.botId} size={28} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("On a call with {name}", { name: call.botName })}
          onPress={() =>
            router.push({ pathname: "/thread", params: { botId: call.botId, name: call.botName } })
          }
        >
          <Text numberOfLines={1} style={[styles.name, { color: tokens.foreground }]}>
            {call.botName}
          </Text>
        </Pressable>
        <Waveform phase={call.phase} />
        <View style={[styles.initial, { backgroundColor: tokens.muted }]}>
          <Text style={[styles.initialText, { color: tokens.mutedForeground }]}>{initial}</Text>
        </View>
      </View>
      <View style={styles.actions}>
        <RoundButton
          label={t("Settings")}
          ios="gearshape"
          android="settings-outline"
          color={tokens.foreground}
          border={tokens.border}
          onPress={() => router.push("/voice")}
        />
        <RoundButton
          label={t("Transcript")}
          ios="captions.bubble"
          android="chatbox-outline"
          selected={call.transcriptOpen}
          color={tokens.foreground}
          border={tokens.border}
          onPress={toggleTranscript}
        />
        <RoundButton
          label={call.muted ? t("Unmute") : t("Mute")}
          ios={call.muted ? "mic.slash" : "mic"}
          android={call.muted ? "mic-off-outline" : "mic-outline"}
          selected={call.muted}
          color={call.muted ? tokens.mutedForeground : tokens.foreground}
          border={tokens.border}
          onPress={toggleMute}
        />
        <RoundButton
          label={t("Hang up")}
          ios="phone.down.fill"
          android="call-outline"
          color={tokens.destructiveForeground}
          border={tokens.destructive}
          background={tokens.destructive}
          onPress={endCall}
        />
      </View>
      {call.transcriptOpen ? (
        <View style={[styles.transcript, { borderTopColor: tokens.border }]}>
          {call.exchanges.slice(-TRANSCRIPT_LINES).map((exchange, index) => (
            <Text
              key={`${exchange.role}-${index + 1}-${exchange.text.slice(0, 24)}`}
              numberOfLines={1}
              style={[
                styles.line,
                { color: exchange.role === "bot" ? tokens.foreground : tokens.mutedForeground },
              ]}
            >
              {exchange.text}
            </Text>
          ))}
          {call.caption || call.heard ? (
            <Text numberOfLines={1} style={[styles.line, { color: tokens.mutedForeground }]}>
              {call.caption || call.heard}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function RoundButton({
  label,
  ios,
  android,
  color,
  border,
  background,
  selected,
  onPress,
}: {
  label: string;
  ios: string;
  android: ComponentProps<typeof NativeSymbol>["android"];
  color: string;
  border: string;
  background?: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={[styles.button, { borderColor: border, backgroundColor: background ?? "transparent" }]}
    >
      <NativeSymbol ios={ios} android={android} size={17} color={color} />
    </Pressable>
  );
}

function Waveform({ phase }: { phase: CallPhase }) {
  const tokens = useMobileTokens();
  const reduceMotion = useReducedMotion();
  const values = useRef(BARS.map(() => new Animated.Value(0.35))).current;
  const still = phase === "thinking" || reduceMotion;

  useEffect(() => {
    if (still) {
      for (const value of values) value.setValue(0.35);
      return;
    }
    const duration = phase === "speaking" ? 300 : 600;
    const loops = values.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 90),
          Animated.timing(value, { toValue: 1, duration, useNativeDriver: true }),
          Animated.timing(value, { toValue: 0.35, duration, useNativeDriver: true }),
        ]),
      ),
    );
    for (const loop of loops) loop.start();
    return () => {
      for (const loop of loops) loop.stop();
    };
  }, [phase, still, values]);

  return (
    <View accessible={false} style={styles.waveform}>
      {BARS.map((height, index) => (
        <Animated.View
          key={`bar-${index + 1}`}
          style={{
            width: 3,
            height,
            borderRadius: 2,
            backgroundColor: still ? tokens.mutedForeground : tokens.foreground,
            transform: [{ scaleY: values[index] ?? 1 }],
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    alignSelf: "center",
    width: 320,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    zIndex: 50,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  name: { fontSize: 15, fontWeight: "500", maxWidth: 110, writingDirection: "auto" },
  waveform: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  initial: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  initialText: { fontSize: 13, fontWeight: "600" },
  actions: { flexDirection: "row", justifyContent: "center", gap: 12, marginTop: 12 },
  button: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  transcript: { marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, gap: 5 },
  line: { fontSize: 13, writingDirection: "auto" },
});
