import { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import {
  activeOrganization,
  leaveDeletedOrganization,
  refreshOrganizations,
  useOrganizations,
} from "../../lib/organizations";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

export default function OrganizationSettings() {
  const { t } = useI18n();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const query = useOrganizations();
  const organization = activeOrganization(query.data);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!organization) {
    return (
      <SafeAreaView edges={["bottom"]} style={styles.screen}>
        <ScrollView style={sideInsets} contentContainerStyle={styles.content}>
          {query.error ? (
            <LoadFailure message={errorText(query.error)} onRetry={() => void query.refetch()} />
          ) : (
            <ActivityIndicator color={native.secondaryLabel} />
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }
  const current = organization;
  const name = draft ?? current.name;
  const canDelete = (query.data?.organizations.length ?? 0) > 1;

  async function rename() {
    const next = name.trim();
    if (!next || next === current.name || pending) {
      setDraft(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await rpc("organizations/rename", { organizationId: current.id, name: next });
      await refreshOrganizations();
      setDraft(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (confirmation.trim() !== current.name.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const { activeSpaceId } = await rpc("organizations/remove", { organizationId: current.id });
      if (!(await leaveDeletedOrganization(current, activeSpaceId)))
        Alert.alert(t("Could not switch spaces"), t("Try again."));
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <SettingsGroup accessibilityLabel={t("Name")} label={t("Name")}>
          <SettingsInputRow
            key="name"
            accessibilityLabel={t("Name")}
            editable={!pending}
            maxLength={60}
            value={name}
            onChangeText={setDraft}
            onEndEditing={() => void rename()}
            returnKeyType="done"
          />
        </SettingsGroup>
        {canDelete ? (
          <SettingsGroup>
            <SettingsRow
              key="delete"
              accessibilityRole="button"
              destructive
              disabled={pending}
              dimmed={pending}
              title={t("Delete organization")}
              onPress={() => {
                setConfirming((open) => !open);
                setConfirmation("");
              }}
            />
            {confirming ? (
              <SettingsInputRow
                key="confirmation"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                editable={!pending}
                placeholder={t("Type {name} to confirm", { name: current.name })}
                value={confirmation}
                onChangeText={setConfirmation}
              />
            ) : null}
            {confirming ? (
              <SettingsRow
                key="confirm"
                accessibilityRole="button"
                destructive
                disabled={pending || confirmation.trim() !== current.name.trim()}
                dimmed={pending || confirmation.trim() !== current.name.trim()}
                title={t("Delete")}
                trailing={
                  pending ? <ActivityIndicator color={mobileTokens().destructive} /> : undefined
                }
                onPress={() => void remove()}
              />
            ) : null}
          </SettingsGroup>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
