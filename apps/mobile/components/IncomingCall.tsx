import { createAudioPlayer } from "expo-audio";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Modal, StyleSheet, Text, Vibration, View } from "react-native";
import { useCallSession } from "../lib/call-session";
import { useI18n } from "../lib/i18n";
import {
  getIncomingCall,
  respondToMobileCall,
  subscribeIncomingCalls,
  usesNativeIncomingCallRingtone,
} from "../lib/incoming-calls";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { BotAvatar } from "./bot-avatar";
import { NativeActionButton } from "./native-action-button";

export function IncomingCall() {
  const incoming = useSyncExternalStore(subscribeIncomingCalls, getIncomingCall, getIncomingCall);
  const active = useCallSession();
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = incoming?.incomingCall.callId;
  useEffect(() => {
    setError(null);
    if (!id || active || usesNativeIncomingCallRingtone()) return;
    const player = createAudioPlayer(require("../assets/sounds/warm-start.m4a"));
    player.loop = true;
    const play = () => {
      if (AppState.currentState === "active") {
        player.play();
        Vibration.vibrate([0, 400, 300, 400, 1500], true);
      } else {
        player.pause();
        Vibration.cancel();
      }
    };
    play();
    const subscription = AppState.addEventListener("change", play);
    return () => {
      subscription.remove();
      player.remove();
      Vibration.cancel();
    };
  }, [id, active]);
  if (!incoming || active) return null;
  const respond = async (action: "answer" | "decline") => {
    setBusy(true);
    setError(null);
    try {
      await respondToMobileCall(incoming, action);
    } catch (error) {
      setError(errorText(error, t("Something went wrong. Try again.")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      visible
      presentationStyle="fullScreen"
      // Back must not reject the call; only Decline does.
      onRequestClose={() => {}}
    >
      <View
        style={[styles.screen, { backgroundColor: tokens.background }]}
        accessibilityViewIsModal
      >
        <BotAvatar
          identity={incoming.id}
          color={incoming.color}
          avatarSet={incoming.avatarSet}
          size={120}
        />
        <Text style={[styles.name, { color: tokens.foreground }]}>{incoming.name}</Text>
        {error ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: 32 }}>
          <NativeActionButton
            label={t("Decline")}
            fill={false}
            prominence="destructive"
            disabled={busy}
            onPress={() => void respond("decline")}
          />
          <NativeActionButton
            label={t("Answer")}
            fill={false}
            disabled={busy}
            onPress={() => void respond("answer")}
          />
        </View>
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 32, padding: 32 },
  name: { fontSize: 28, fontWeight: "600" },
});
