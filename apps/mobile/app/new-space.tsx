import { useLingui } from "@lingui/react/macro";
import { Stack, useNavigation, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, Text, TextInput } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { cancelHeaderOptions } from "../components/sheet-header";
import { rpc } from "../lib/api";
import { selectSpace } from "../lib/api-server";
import { hapticSuccess } from "../lib/haptics";
import { native, useMobileTokens } from "../lib/native";
import { refreshOrganizations } from "../lib/organizations";
import { isSearchInboxSession, searchInboxSession } from "../lib/search-inbox";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function NewSpace() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const router = useRouter();
  const navigation = useNavigation();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    const askedIn = searchInboxSession();
    try {
      const space = await rpc("spaces/create", { name: trimmed });
      if (navigation.isFocused() && isSearchInboxSession(askedIn)) hapticSuccess();
      void refreshOrganizations();
      if (!(await selectSpace(space.id))) {
        Alert.alert(t`Space created`, t`It could not be opened. Try again from the sidebar.`);
        router.dismissAll();
        router.replace("/");
        return;
      }
      router.dismissAll();
      router.replace("/");
    } catch (reason) {
      setError(errorText(reason, t`Could not create space`));
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen options={cancelHeaderOptions(t`Cancel`, () => router.back())} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t`Name`}</Text>
        <TextInput
          autoFocus
          value={name}
          maxLength={60}
          onChangeText={setName}
          onSubmitEditing={() => void create()}
          placeholder={t`Customer support`}
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
        {error ? <Text style={{ color: tokens.destructive, marginTop: 14 }}>{error}</Text> : null}
        <NativeActionButton
          disabled={!name.trim() || pending}
          label={pending ? t`Creating…` : t`Create space`}
          onPress={() => void create()}
          style={{ marginTop: 20 }}
        />
      </ScrollView>
    </>
  );
}
