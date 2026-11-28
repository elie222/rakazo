import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import { typeScale } from "@rakazo/ui-tokens";
import { AudioModule } from "expo-audio";
import { useKeepAwake } from "expo-keep-awake";
import { useRouter } from "expo-router";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Animated, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { startCallBackground, stopCallBackground } from "../../lib/calls/call-background";
import type { CallPhase, CallState } from "../../lib/calls/call-session";
import { hangUp, toggleMute, toggleTranscript, useCallSession } from "../../lib/calls/call-session";
import { useMobileTokens } from "../../lib/native/native";
import { getVoicePlaybackState, subscribeVoicePlayback } from "../../lib/voice/voice";
import { BotAvatar } from "../bots/bot-avatar";
import { GlassIconButton } from "../native/glass-icon-button";
import type { NativeSymbol } from "../native/native-symbol";

const BARS = [12, 22, 32, 22, 12];
const TRANSCRIPT_LINES = 4;
const START_RETRY_MS = 3000;
const START_ATTEMPTS = 20;

function callClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Whole seconds since this call opened, ticking while it is on. */
function useCallElapsed(call: CallState | null): number {
  const [opened, setOpened] = useState<{ botId: string; at: number } | null>(null);
  if (call && opened?.botId !== call.botId) setOpened({ botId: call.botId, at: Date.now() });
  if (!call && opened) setOpened(null);
  const now = useNow(call ? 1000 : null);
  return opened ? Math.max(0, Math.floor((now - opened.at) / 1000)) : 0;
}

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
  // The call fills the screen, as on desktop; minimized, it waits in a bar above the composer.
  const [minimized, setMinimized] = useState(false);
  const [serviceStarted, setServiceStarted] = useState(false);
  const serviceStartedFor = useRef<string | null>(null);
  const startSeq = useRef(0);
  const onCall = Boolean(call);
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
      setMinimized(false);
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

  const elapsed = useCallElapsed(call);
  if (!call) return null;
  const recentExchanges = call.exchanges.slice(-TRANSCRIPT_LINES);
  const activity =
    call.phase === "speaking"
      ? t`Speaking`
      : call.phase === "thinking"
        ? t`Thinking`
        : call.muted
          ? t`Muted`
          : t`Listening`;
  const openChat = () => {
    setMinimized(true);
    router.push({ pathname: "/thread", params: { botId: call.botId, name: call.botName } });
  };
  return (
    <>
      {Platform.OS !== "android" || !serviceStarted ? <KeepCallAwake /> : null}
      {minimized ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t`Return to call with ${ph({ name: call.botName })}`}
          onPress={() => setMinimized(false)}
          style={({ pressed }) => [
            styles.returnBar,
            {
              backgroundColor: tokens.success,
              marginBottom: playback.status === "idle" ? insets.bottom + 8 : 0,
            },
            pressed && styles.pressed,
          ]}
        >
          <Text numberOfLines={1} style={[styles.returnText, { color: tokens.background }]}>
            {t`Return to call with ${ph({ name: call.botName })}`}
          </Text>
          <Text style={[styles.returnText, styles.clock, { color: tokens.background }]}>
            {callClock(elapsed)}
          </Text>
        </Pressable>
      ) : null}
      <Modal
        visible={!minimized}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setMinimized(true)}
      >
        <View
          accessibilityViewIsModal
          accessibilityLabel={t`Call with ${ph({ name: call.botName })}`}
          style={[
            styles.screen,
            {
              backgroundColor: tokens.background,
              paddingTop: insets.top + 8,
              paddingBottom: Math.max(insets.bottom, 12) + 20,
            },
          ]}
        >
          <View style={styles.topRow}>
            <RoundButton
              label={t`Minimize call`}
              ios="chevron.down"
              android="chevron-down"
              color={tokens.foreground}
              border={tokens.border}
              onPress={() => setMinimized(true)}
            />
            <View style={{ flex: 1 }} />
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
              label={t`Settings`}
              ios="gearshape"
              android="settings-outline"
              color={tokens.foreground}
              border={tokens.border}
              onPress={() => {
                setMinimized(true);
                router.push("/voice");
              }}
            />
          </View>
          <View style={styles.center}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t`Open chat with ${ph({ name: call.botName })}`}
              onPress={openChat}
            >
              <BotAvatar
                color={call.botColor}
                avatarSet={call.botAvatarSet}
                identity={call.botId}
                size={128}
                motion="live"
              />
            </Pressable>
            <Text numberOfLines={1} style={[styles.name, { color: tokens.foreground }]}>
              {call.botName}
            </Text>
            <View style={styles.status}>
              <Text style={[styles.statusText, styles.clock, { color: tokens.mutedForeground }]}>
                {callClock(elapsed)}
              </Text>
              <Text
                accessibilityLiveRegion="polite"
                style={[styles.statusText, { color: tokens.mutedForeground }]}
              >
                {activity}
              </Text>
            </View>
            <Waveform phase={call.phase} />
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
                      {
                        color:
                          exchange?.role === "bot" ? tokens.foreground : tokens.mutedForeground,
                      },
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
          ) : call.caption ? (
            <Text style={[styles.caption, { color: tokens.mutedForeground }]}>{call.caption}</Text>
          ) : null}
          <View style={styles.controls}>
            <RoundButton
              caption={call.muted ? t`Unmute` : t`Mute`}
              label={call.muted ? t`Unmute` : t`Mute`}
              ios={call.muted ? "mic.slash.fill" : "mic.fill"}
              android={call.muted ? "mic-off" : "mic"}
              selected={call.muted}
              size={68}
              color={call.muted ? tokens.primaryForeground : tokens.foreground}
              border={tokens.border}
              background={call.muted ? tokens.primary : undefined}
              onPress={toggleMute}
            />
            <RoundButton
              caption={t`End`}
              label={t`Hang up`}
              ios="phone.down.fill"
              android={{ material: "phone-hangup" }}
              size={68}
              color={tokens.destructiveForeground}
              border={tokens.destructiveFill}
              background={tokens.destructiveFill}
              onPress={hangUp}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

function RoundButton({
  label,
  caption,
  ios,
  android,
  color,
  border,
  background,
  selected,
  size = 44,
  onPress,
}: {
  label: string;
  /** A word under the button, as on a phone call; the button keeps `label` for VoiceOver. */
  caption?: string;
  ios: string;
  android: ComponentProps<typeof NativeSymbol>["android"];
  color: string;
  border: string;
  background?: string;
  selected?: boolean;
  size?: number;
  onPress: () => void;
}) {
  const tokens = useMobileTokens();
  const button = (
    <GlassIconButton
      accessibilityLabel={label}
      ios={ios}
      android={android}
      size={size}
      iconSize={size > 44 ? 28 : 20}
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
  if (!caption) return button;
  return (
    <View style={styles.captioned}>
      {button}
      <Text
        importantForAccessibility="no"
        accessibilityElementsHidden
        style={[styles.buttonCaption, { color: tokens.mutedForeground }]}
      >
        {caption}
      </Text>
    </View>
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
            width: 4,
            height,
            borderRadius: 2,
            backgroundColor: phase === "speaking" ? tokens.foreground : tokens.mutedForeground,
            transform: [{ scaleY: values[index] ?? 1 }],
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 20 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14 },
  name: { fontSize: 30, lineHeight: 36, fontWeight: "600", marginTop: 8, writingDirection: "auto" },
  status: { flexDirection: "row", gap: 8 },
  statusText: { ...typeScale.body },
  clock: { fontVariant: ["tabular-nums"] },
  waveform: { height: 36, flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 },
  transcript: {
    marginBottom: 20,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  line: { ...typeScale.secondary, writingDirection: "auto" },
  caption: { ...typeScale.secondary, textAlign: "center", marginBottom: 20 },
  controls: { flexDirection: "row", justifyContent: "center", gap: 36 },
  captioned: { alignItems: "center", gap: 8 },
  buttonCaption: { ...typeScale.caption },
  buttonFallback: { borderWidth: StyleSheet.hairlineWidth },
  returnBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 44,
    marginTop: 8,
    marginHorizontal: 16,
    paddingHorizontal: 16,
    borderRadius: 22,
  },
  returnText: { ...typeScale.secondary, fontWeight: "600", flexShrink: 1 },
  pressed: { opacity: 0.8 },
});
