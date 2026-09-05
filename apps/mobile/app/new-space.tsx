import type { Space } from "@rakazo/contracts";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput } from "react-native";
import { rpc, selectSpace } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export default function NewSpace() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const space = await rpc<Space>("spaces/create", { name: trimmed });
      if (!(await selectSpace(space.id))) {
        Alert.alert(t("Space created"), t("It could not be opened. Try again from the sidebar."));
        router.dismissAll();
        router.replace("/");
        return;
      }
      router.dismissAll();
      router.replace("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Could not create space"));
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              hitSlop={8}
              style={{ paddingEnd: 20, paddingVertical: 8 }}
              accessibilityRole="button"
              accessibilityLabel={t("Cancel")}
            >
              <Text style={{ color: tokens.foreground, fontSize: 17 }}>{t("Cancel")}</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          autoFocus
          value={name}
          maxLength={60}
          onChangeText={setName}
          onSubmitEditing={() => void create()}
          placeholder={t("Customer support")}
          placeholderTextColor={tokens.mutedForeground}
          returnKeyType="done"
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 14,
            color: tokens.foreground,
            fontSize: 16,
          }}
        />
        {error ? <Text style={{ color: tokens.destructive, marginTop: 14 }}>{error}</Text> : null}
        <Pressable
          onPress={() => void create()}
          disabled={!name.trim() || pending}
          style={{
            marginTop: 20,
            backgroundColor: tokens.primary,
            borderRadius: 11,
            padding: 14,
            alignItems: "center",
            opacity: !name.trim() || pending ? 0.4 : 1,
          }}
        >
          <Text style={{ color: tokens.primaryForeground, fontSize: 16, fontWeight: "600" }}>
            {pending ? t("Creating…") : t("Create space")}
          </Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
