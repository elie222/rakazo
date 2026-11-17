import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { accountDisplay } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useQuery } from "@tanstack/react-query";
import { AudioModule } from "expo-audio";
import { useKeepAwake } from "expo-keep-awake";
import { useRouter } from "expo-router";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { currentSessionGeneration, subscribeSessionGeneration } from "../../lib/api/session";
import { startCallBackground, stopCallBackground } from "../../lib/calls/call-background";
import type { CallPhase } from "../../lib/calls/call-session";
import { hangUp, toggleMute, toggleTranscript, useCallSession } from "../../lib/calls/call-session";
import { useMobileTokens } from "../../lib/native/native";
import { accountRpcQuery, queryClient } from "../../lib/query/query";
import { getVoicePlaybackState, subscribeVoicePlayback } from "../../lib/voice/voice";
import { BotAvatar } from "../bots/bot-avatar";
import { GlassIconButton } from "../native/glass-icon-button";
import { GlassSurface } from "../native/glass-surface";
import type { NativeSymbol } from "../native/native-symbol";

const BARS = [9, 15, 21, 15, 9];
const TRANSCRIPT_LINES = 4;
const START_RETRY_MS = 3000;
const START_ATTEMPTS = 20;

/** Fallback until the native call service owns the call. */
function KeepCallAwake() {
  useKeepAwake("rakazo-call");
  return null;
}

export function CallCard() {
  const call = useCallSession();
  const playback = useSyncExternalStore(subscribeVoicePlayback, getVoicePlaybackState);
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // The card stays mounted across account switches; the next account reads its own initial.
  useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const [serviceStarted, setServiceStarted] = useState(false);
  const serviceStartedFor = useRef<string | null>(null);
  const startSeq = useRef(0);
  const onCall = Boolean(call);
  const me = useQuery({ ...accountRpcQuery("me"), enabled: onCall }, queryClient).data;
  const initial = me ? (accountDisplay(me, t`You`).initial ?? "") : "";
  // A crash inside the call UI unmounts this card without ending the call, so the
  // service and its wake lock are released here rather than on the next call change.
  const mountedCall = useRef(false);
  mountedCall.current = onCall;
  useEffect(
    () => () => {
      if (mountedCall.current) void stopCallBackground();
    },
    [],
  );

  // A microphone foreground service keeps the call alive when the display sleeps.
  // Start it only after the microphone permission is granted; retry when the call
  // phase changes or a moment passes, because the first turn may have just shown
  // the permission prompt.
  useEffect(() => {
    if (!call) {
      startSeq.current += 1;
      serviceStartedFor.current = null;
      setServiceStarted(false);
      void stopCallBackground();
      return;
    }
    if (Platform.OS !== "android" || serviceStartedFor.current === call.botId) return;
    startSeq.current += 1;
    const seq = startSeq.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const retry = () => {
      if (cancelled || attempts >= START_ATTEMPTS) return;
      attempts += 1;
      timer = setTimeout(() => void attempt(), START_RETRY_MS);
    };
    const attempt = async () => {
      try {
        const permission = await AudioModule.getRecordingPermissionsAsync();
        if (cancelled || seq !== startSeq.current) return;
        if (!permission.granted) return retry();
        const started = await startCallBackground(call.botName);
        // A newer attempt owns the service now, so its result decides the fallback.
        if (cancelled || seq !== startSeq.current) return;
        if (!started) return retry();
        serviceStartedFor.current = call.botId;
        setServiceStarted(true);
      } catch {
        // Keep the screen-awake fallback when the native service is unavailable.
      }
    };
    void attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [call?.botId, call?.botName, call?.phase]);

  if (!call) return null;
  const recentExchanges = call.exchanges.slice(-TRANSCRIPT_LINES);
  return (
    <GlassSurface
      shape="roundedRectangle"
      style={[styles.card, { marginBottom: playback.status === "idle" ? insets.bottom + 8 : 0 }]}
      fallbackStyle={[
        styles.cardFallback,
        {
          backgroundColor: tokens.glassFill,
          borderColor: tokens.glassStroke,
          shadowColor: tokens.foreground,
        },
      ]}
    >
      {Platform.OS !== "android" || !serviceStarted ? <KeepCallAwake /> : null}
      <View style={styles.row}>
        <BotAvatar
          color={call.botColor}
          avatarSet={call.botAvatarSet}
          identity={call.botId}
          size={28}
          motion="live"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t`On a call with ${ph({ name: call.botName })}`}
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
          label={t`Settings`}
          ios="gearshape"
          android="settings-outline"
          color={tokens.foreground}
          border={tokens.border}
          onPress={() => router.push("/voice")}
        />
        <RoundButton
          label={t`Transcript`}
          ios="captions.bubble"
          android="chatbox-outline"
          selected={call.transcriptOpen}
          color={tokens.foreground}
          border={tokens.border}
          onPress={toggleTranscript}
        />
        <RoundButton
          label={call.muted ? t`Unmute` : t`Mute`}
          ios={call.muted ? "mic.slash" : "mic"}
          android={call.muted ? "mic-off-outline" : "mic-outline"}
          selected={call.muted}
          color={call.muted ? tokens.mutedForeground : tokens.foreground}
          border={tokens.border}
          onPress={toggleMute}
        />
        <RoundButton
          label={t`Hang up`}
          ios="phone.down.fill"
          android={{ material: "phone-hangup" }}
          color={tokens.destructiveForeground}
          border={tokens.destructiveFill}
          background={tokens.destructiveFill}
          onPress={hangUp}
        />
      </View>
      {call.transcriptOpen ? (
        <View style={[styles.transcript, { borderTopColor: tokens.border }]}>
          {Array.from({ length: TRANSCRIPT_LINES }, (_, index) => {
            const exchange = recentExchanges[index];
            return (
              <Text
                key={`transcript-${index + 1}`}
                numberOfLines={1}
                style={[
                  styles.line,
                  { color: exchange?.role === "bot" ? tokens.foreground : tokens.mutedForeground },
                ]}
              >
                {exchange?.text || " "}
              </Text>
            );
          })}
          <Text numberOfLines={1} style={[styles.line, { color: tokens.mutedForeground }]}>
            {call.caption || call.heard || " "}
          </Text>
        </View>
      ) : null}
    </GlassSurface>
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
    <GlassIconButton
      accessibilityLabel={label}
      ios={ios}
      android={android}
      size={44}
      color={color}
      tint={background}
      selected={selected}
      onPress={onPress}
      fallbackStyle={[
        styles.buttonFallback,
        { borderColor: border, backgroundColor: background ?? "transparent" },
      ]}
    />
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
    alignSelf: "center",
    width: 320,
    maxWidth: "100%",
    marginTop: 8,
    padding: 12,
  },
  cardFallback: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  name: { ...typeScale.cardTitle, maxWidth: 110, writingDirection: "auto" },
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
  buttonFallback: { borderWidth: StyleSheet.hairlineWidth },
  transcript: { marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, gap: 5 },
  line: { ...typeScale.secondary, writingDirection: "auto" },
});
