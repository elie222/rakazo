import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { deleteAccount, type MobileMe, rpc, signOut } from "../lib/api";
import { native } from "../lib/native";

export default function Account() {
  const router = useRouter();
  const [me, setMe] = useState<MobileMe | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void rpc<MobileMe>("me")
      .then(setMe)
      .catch(() => undefined);
  }, []);

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
      <View style={styles.content}>
        <View style={styles.profile}>
          <Text style={styles.name}>{me?.name || "Your account"}</Text>
          {me?.email ? <Text style={styles.email}>{me.email}</Text> : null}
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => void handleSignOut()}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Text style={styles.buttonLabel}>Sign out</Text>
        </Pressable>

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
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: native.page,
  },
  content: {
    flex: 1,
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
