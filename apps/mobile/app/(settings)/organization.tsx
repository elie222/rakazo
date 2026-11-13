import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { canDeleteOrganization } from "@rakazo/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { native, useThemedStyles } from "../../lib/native";
import {
  activeOrganization,
  leaveDeletedOrganization,
  refreshOrganizations,
  useOrganizations,
} from "../../lib/organizations";
import { openFromSettingsSheet } from "../../lib/settings-sheet";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

export default function OrganizationSettings() {
  const { t } = useLingui();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const query = useOrganizations();
  const organization = activeOrganization(query.data);
  const [draft, setDraft] = useState<string | null>(null);
  // The plan choice links here with the deletion confirmation already open.
  const deleteRequested = useLocalSearchParams<{ delete?: string }>().delete === "1";
  const [confirming, setConfirming] = useState(deleteRequested);
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
  const canDelete = canDeleteOrganization(query.data?.organizations ?? [], current);

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
      await leaveDeletedOrganization(current, activeSpaceId);
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
        <SettingsGroup accessibilityLabel={t`Name`} label={t`Name`}>
          {current.canManage ? (
            <SettingsInputRow
              key="name"
              accessibilityLabel={t`Name`}
              editable={!pending}
              maxLength={60}
              value={name}
              onChangeText={setDraft}
              onEndEditing={() => void rename()}
              returnKeyType="done"
            />
          ) : (
            <SettingsRow key="name" title={current.name} />
          )}
        </SettingsGroup>
        <SettingsGroup>
          <SettingsRow
            key="create"
            accessibilityRole="button"
            disabled={pending}
            title={t`Create organization`}
            onPress={() => openFromSettingsSheet(router, "/new-organization")}
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
              title={t`Delete organization`}
              onPress={() => {
                setConfirming((open) => !open);
                setConfirmation("");
              }}
            />
            {confirming ? (
              <SettingsInputRow
                key="confirmation"
                accessibilityLabel={t`Type ${ph({ name: current.name })} to confirm`}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                editable={!pending}
                placeholder={t`Type ${ph({ name: current.name })} to confirm`}
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
                title={t`Delete`}
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
