import { useLingui } from "@lingui/react/macro";
import { typeScale } from "@rakazo/ui-tokens";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsInputRow } from "../components/settings-group";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { native, useThemedStyles } from "../lib/native";
import { refreshOrganizations, switchOrganization, useOrganizations } from "../lib/organizations";
import { errorText } from "../lib/user-error";

export default function NewOrganization() {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  const organizations = useOrganizations().data;
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const creating = useRef(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || creating.current) return;
    creating.current = true;
    setPending(true);
    setError(null);
    try {
      const created = await rpc("organizations/create", { name: trimmed });
      const target = { ...created, spaceIds: [created.defaultSpaceId], canManage: true };
      if (!(await switchOrganization(target, organizations?.organizations ?? []))) {
        void refreshOrganizations();
        Alert.alert(t`Could not switch spaces`, t`Try again.`);
        router.dismissAll();
        router.replace("/");
      }
    } catch (reason) {
      setError(errorText(reason, t`Something went wrong. Try again.`));
      creating.current = false;
      setPending(false);
    }
  }

  return (
    <View style={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>
        {t`Create organization`}
      </Text>
      <SettingsGroup>
        <SettingsInputRow
          accessibilityLabel={t`Name`}
          autoFocus
          editable={!pending}
          maxLength={60}
          placeholder={t`Name`}
          value={name}
          onChangeText={setName}
          onSubmitEditing={() => void create()}
          returnKeyType="done"
        />
      </SettingsGroup>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <NativeActionButton
        disabled={!name.trim() || pending}
        label={pending ? t`Creating…` : t`Create`}
        onPress={() => void create()}
      />
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    content: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 24, gap: 20 },
    title: { ...typeScale.title, color: native.label, textAlign: "center" },
    error: { ...typeScale.caption, color: mobileTokens().destructive },
  });
}
