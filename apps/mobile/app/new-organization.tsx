import { useLingui } from "@lingui/react/macro";
import { typeScale } from "@rakazo/ui-tokens";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsInputRow } from "../components/settings-group";
import { mobileTokens } from "../lib/appearance";
import { native, useThemedStyles } from "../lib/native";
import type { Organization } from "../lib/organizations";
import { refreshOrganizations, switchOrganization, useOrganizations } from "../lib/organizations";
import { useSave } from "../lib/query";
import { ACCOUNT_SETTINGS } from "../lib/settings-target";
import { errorText } from "../lib/user-error";

export default function NewOrganization() {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  const organizations = useOrganizations().data;
  const [name, setName] = useState("");
  const creation = useSave({
    // An organization belongs to the account, so opening it does not end the save that made it.
    target: ACCOUNT_SETTINGS,
    save: async (ask: { name: string; organizations: readonly Organization[] }, send) => {
      const created = await send("organizations/create", { name: ask.name });
      const target = {
        ...created,
        spaceIds: [created.defaultSpaceId],
        canManage: true,
        role: "owner" as const,
        memberCount: 1,
      };
      // It exists by now, so it is opened even when this sheet has been closed meanwhile.
      if (!(await switchOrganization(target, ask.organizations))) {
        void refreshOrganizations();
        Alert.alert(t`Could not switch spaces`, t`Try again.`);
        router.dismissAll();
        router.replace("/");
      }
    },
    closesScreen: true,
  });
  const pending = creation.pending;
  const error = creation.error
    ? errorText(creation.error, t`Something went wrong. Try again.`)
    : null;

  function create() {
    const trimmed = name.trim();
    if (trimmed) creation.run({ name: trimmed, organizations: organizations?.organizations ?? [] });
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
          onSubmitEditing={create}
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
        onPress={create}
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
