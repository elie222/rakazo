import type { AvatarStyle } from "@rakazo/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAvatarStyle } from "../components/avatar-style";
import { BotAvatar } from "../components/bot-avatar";
import type { MobileBot } from "../lib/api";
import { deleteAccount, type MobileMe, rpc, signOut } from "../lib/api";
import { confirmDeleteBot } from "../lib/bot-lifecycle";
import { native } from "../lib/native";

export default function Account() {
  const router = useRouter();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const [me, setMe] = useState<MobileMe | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archivedBots, setArchivedBots] = useState<MobileBot[]>([]);
  const [usage, setUsage] = useState<{
    runs: number;
    inputTokens: number;
    outputTokens: number;
  } | null>(null);
  const { avatarStyle, updateAvatarStyle } = useAvatarStyle();

  useEffect(() => {
    void rpc<MobileMe>("me")
      .then(setMe)
      .catch(() => undefined);
    void rpc<MobileBot[]>("bots/listArchived")
      .then(setArchivedBots)
      .catch(() => undefined);
    void rpc<{ runs: number; inputTokens: number; outputTokens: number }>("usage/summary")
      .then(setUsage)
      .catch(() => undefined);
  }, []);

  const usageBlock = (
    <View accessibilityLabel="Usage" style={styles.profile}>
      <Text style={styles.settingsTitle}>Usage</Text>
      {usage ? (
        <Text style={styles.email}>
          {usage.runs} runs · {usage.inputTokens + usage.outputTokens} tokens
        </Text>
      ) : null}
      <Text style={styles.settingsExplanation}>Model spend uses your provider keys.</Text>
    </View>
  );

  async function restoreBot(botId: string) {
    try {
      await rpc("bots/restore", { botId });
      setArchivedBots((bots) => bots.filter((bot) => bot.id !== botId));
    } catch (restoreError) {
      Alert.alert(
        "Could not restore bot",
        restoreError instanceof Error ? restoreError.message : "Try again.",
      );
    }
  }

  async function selectAvatarStyle(next: AvatarStyle) {
    if (next === avatarStyle) return;
    setAvatarPending(true);
    setAvatarError(null);
    try {
      await updateAvatarStyle(next);
    } catch {
      setAvatarError("Couldn't update avatars");
    } finally {
      setAvatarPending(false);
    }
  }

  async function handleSignOut() {
    setPending(true);
    await signOut();
    router.dismissAll();
    router.replace("/sign-in");
  }

  function confirmDeletion() {
    setError(null);
    Alert.alert(
      "Delete your account?",
      "This permanently deletes your account, bots, conversations, memories, files, and saved connections. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: () => void handleDeletion(),
        },
      ],
    );
  }

  async function handleDeletion() {
    setPending(true);
    setError(null);
    try {
      await deleteAccount(password);
      router.dismissAll();
      router.replace("/sign-in");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete account");
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        {focus === "usage" ? usageBlock : null}
        <View style={styles.profile}>
          <Text style={styles.name}>{me?.name || "Your account"}</Text>
          {me?.email ? <Text style={styles.email}>{me.email}</Text> : null}
        </View>
        {focus !== "usage" ? usageBlock : null}

        <View accessibilityLabel="Avatar style" style={styles.avatarSection}>
          <Text style={styles.settingsTitle}>Avatars</Text>
          <View style={styles.avatarOptions}>
            {(["robot", "organic"] as const).map((style) => {
              const selected = avatarStyle === style;
              return (
                <Pressable
                  key={style}
                  accessibilityLabel={`${style === "robot" ? "Robot" : "Organic"} avatars`}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled: avatarPending }}
                  disabled={avatarPending}
                  onPress={() => void selectAvatarStyle(style)}
                  style={({ pressed }) => [
                    styles.avatarOption,
                    selected && styles.avatarOptionSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <BotAvatar
                    color={style === "robot" ? "#8B5CF6" : "#D62F8B"}
                    identity="avatar-preview"
                    size={42}
                    variant={style}
                  />
                  <Text style={styles.avatarLabel}>{style === "robot" ? "Robot" : "Organic"}</Text>
                </Pressable>
              );
            })}
          </View>
          {avatarError ? <Text style={styles.error}>{avatarError}</Text> : null}
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => router.push("/models")}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <View>
            <Text style={styles.settingsTitle}>Models</Text>
            <Text style={styles.settingsExplanation}>Choose your provider and active model</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => router.push("/voice")}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <View>
            <Text style={styles.settingsTitle}>Voice</Text>
            <Text style={styles.settingsExplanation}>
              Speak replies aloud with ElevenLabs, OpenAI, or Cartesia
            </Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => router.push("/integrations")}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <View>
            <Text style={styles.settingsTitle}>Integrations</Text>
            <Text style={styles.settingsExplanation}>Connect apps.</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => void handleSignOut()}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Text style={styles.buttonLabel}>Sign out</Text>
        </Pressable>

        {archivedBots.length > 0 ? (
          <View style={styles.archivedSection}>
            <Text style={styles.sectionTitle}>Archived bots</Text>
            {archivedBots.map((bot) => (
              <View key={bot.id} style={styles.archivedRow}>
                <Text numberOfLines={1} style={styles.archivedName}>
                  {bot.name}
                </Text>
                <Pressable onPress={() => void restoreBot(bot.id)} hitSlop={8}>
                  <Text style={styles.restoreLabel}>Restore</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    confirmDeleteBot(bot, () =>
                      setArchivedBots((bots) => bots.filter((item) => item.id !== bot.id)),
                    )
                  }
                  hitSlop={8}
                >
                  <Text style={styles.archivedDeleteLabel}>Delete</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.dangerZone}>
          <Text style={styles.dangerTitle}>Delete account</Text>
          <Text style={styles.explanation}>
            Enter your current password, then confirm permanent deletion of your account and all
            associated data.
          </Text>
          <TextInput
            accessibilityLabel="Current password"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            onChangeText={(value) => {
              setPassword(value);
              setError(null);
            }}
            placeholder="Current password"
            placeholderTextColor={native.tertiaryLabel}
            secureTextEntry
            style={styles.password}
            textContentType="password"
            value={password}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            accessibilityRole="button"
            disabled={pending || !password}
            onPress={confirmDeletion}
            style={({ pressed }) => [
              styles.deleteButton,
              (pending || !password) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {pending ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.deleteLabel}>Delete account</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: native.page,
  },
  content: {
    flexGrow: 1,
    padding: 20,
    gap: 20,
  },
  profile: {
    borderRadius: 16,
    backgroundColor: native.fill,
    padding: 18,
    gap: 4,
  },
  name: {
    color: native.label,
    fontSize: 20,
    fontWeight: "600",
  },
  email: {
    color: native.secondaryLabel,
    fontSize: 15,
  },
  button: {
    minHeight: 50,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: native.fill,
  },
  buttonLabel: {
    color: native.label,
    fontSize: 17,
    fontWeight: "600",
  },
  archivedSection: {
    borderRadius: 16,
    backgroundColor: native.fill,
    padding: 18,
    gap: 14,
  },
  sectionTitle: {
    color: native.secondaryLabel,
    fontSize: 14,
    fontWeight: "600",
  },
  archivedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  archivedName: {
    flex: 1,
    color: native.label,
    fontSize: 16,
  },
  restoreLabel: {
    color: native.label,
    fontSize: 14,
    fontWeight: "600",
  },
  archivedDeleteLabel: {
    color: "#FF6961",
    fontSize: 14,
  },
  settingsButton: {
    minHeight: 62,
    borderRadius: 14,
    backgroundColor: native.fill,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  avatarSection: {
    borderRadius: 16,
    backgroundColor: native.fill,
    padding: 18,
    gap: 14,
  },
  avatarOptions: {
    flexDirection: "row",
    gap: 12,
  },
  avatarOption: {
    flex: 1,
    minHeight: 86,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: native.tertiaryLabel,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  avatarOptionSelected: {
    borderColor: native.label,
    backgroundColor: native.fillPressed,
  },
  avatarLabel: {
    color: native.label,
    fontSize: 14,
    fontWeight: "600",
  },
  settingsTitle: {
    color: native.label,
    fontSize: 17,
    fontWeight: "600",
  },
  settingsExplanation: {
    color: native.secondaryLabel,
    fontSize: 13,
    marginTop: 3,
  },
  chevron: {
    color: native.secondaryLabel,
    fontSize: 28,
    fontWeight: "300",
  },
  dangerZone: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#5A2426",
    padding: 18,
  },
  dangerTitle: {
    color: "#FF6961",
    fontSize: 17,
    fontWeight: "600",
  },
  explanation: {
    color: native.secondaryLabel,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  password: {
    height: 48,
    borderRadius: 12,
    backgroundColor: native.fill,
    color: native.label,
    paddingHorizontal: 14,
    marginTop: 16,
    fontSize: 16,
  },
  error: {
    color: "#FF6961",
    fontSize: 14,
    marginTop: 10,
  },
  deleteButton: {
    minHeight: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#C9363E",
    marginTop: 14,
  },
  deleteLabel: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.7,
  },
});
