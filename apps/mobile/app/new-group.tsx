import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@rakazo/contracts";
import { Stack, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotMemberPicker } from "../components/bot-member-picker";
import { NativeActionButton } from "../components/native-action-button";
import type { MobileBot } from "../lib/api";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";

export default function NewGroup() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void rpc<MobileBot[]>("bots/list")
      .then((nextBots) => setBots(nextBots.filter((bot) => !bot.archivedAt)))
      .catch(() => undefined);
  }, []);

  async function create() {
    if (
      !name.trim() ||
      selected.length < GROUP_MEMBER_MIN ||
      selected.length > GROUP_MEMBER_MAX ||
      pending
    )
      return;
    setPending(true);
    setError(null);
    try {
      const group = await rpc<{ id: string; name: string }>("groups/create", {
        name: name.trim(),
        botIds: selected,
      });
      router.replace({
        pathname: "/group-thread",
        params: { groupId: group.id, name: group.name },
      });
    } catch (err) {
      setError(errorText(err, t("Could not create group")));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: t("New group") }} />
      <KeyboardAvoidingView
        behavior="padding"
        automaticOffset
        style={{ flex: 1, backgroundColor: tokens.background }}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 24 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t("Name this group")}
            placeholderTextColor={tokens.mutedForeground}
            returnKeyType="done"
            style={{
              marginTop: 8,
              backgroundColor: native.fill,
              borderRadius: 11,
              padding: 14,
              color: tokens.foreground,
              fontSize: 16,
            }}
          />
          <BotMemberPicker
            bots={bots}
            selected={selected}
            onChange={setSelected}
            disabled={pending}
            initiallyExpanded
          />
          {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
        </ScrollView>
        {/* Rides on top of the keyboard while the name is typed, above the home indicator otherwise. */}
        <View
          style={{
            paddingHorizontal: 24,
            paddingTop: 12,
            paddingBottom: keyboardVisible ? 12 : Math.max(insets.bottom, 12),
          }}
        >
          <NativeActionButton
            disabled={
              !name.trim() ||
              selected.length < GROUP_MEMBER_MIN ||
              selected.length > GROUP_MEMBER_MAX ||
              pending
            }
            label={pending ? t("Creating…") : t("Create group")}
            onPress={() => void create()}
          />
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
