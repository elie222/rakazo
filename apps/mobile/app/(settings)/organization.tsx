import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { canDeleteOrganization, canManageOrganizationMembers } from "@rakazo/core";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsRow,
} from "../../components/settings/settings-group";
import { LoadFailure } from "../../components/ui/load-failure";
import { useLiveStream } from "../../lib/api/roster-signals";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { useSave } from "../../lib/query/query";
import { ACCOUNT_SETTINGS } from "../../lib/query/settings-target";
import type { Organization } from "../../lib/spaces/organizations";
import {
  activeOrganization,
  leaveDeletedOrganization,
  refreshOrganizations,
  useOrganizations,
} from "../../lib/spaces/organizations";

export default function OrganizationSettings() {
  const { t } = useLingui();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const query = useOrganizations();
  // Someone else's change to the members reaches this screen as a signal on the live stream.
  useLiveStream(useIsFocused());
  const organization = activeOrganization(query.data);
  const [draft, setDraft] = useState<string | null>(null);
  // The plan choice links here with the deletion confirmation already open.
  const deleteRequested = useLocalSearchParams<{ delete?: string }>().delete === "1";
  const [confirming, setConfirming] = useState(deleteRequested);
  const [confirmation, setConfirmation] = useState("");
  const renaming = useSave({
    save: async (ask: { organization: Organization; name: string }, send) => {
      await send("organizations/rename", { organizationId: ask.organization.id, name: ask.name });
      // The name shows in the list cached for every Space, not only this one.
      await refreshOrganizations();
    },
    onSaved: () => setDraft(null),
  });
  const removal = useSave({
    // Deleting selects a Space of another organization, which must not hand Delete back.
    target: ACCOUNT_SETTINGS,
    save: async (deleted: Organization, send) => {
      const { activeSpaceId } = await send("organizations/remove", { organizationId: deleted.id });
      await leaveDeletedOrganization(deleted, activeSpaceId);
    },
    closesScreen: true,
  });
  const pending = renaming.pending || removal.pending;
  const failure = removal.error ?? renaming.error;
  const error = failure ? errorText(failure) : null;

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

  function rename() {
    const next = name.trim();
    if (!next || next === current.name || pending) {
      setDraft(null);
      return;
    }
    removal.reset();
    renaming.run({ organization: current, name: next });
  }

  function remove() {
    if (confirmation.trim() !== current.name.trim() || pending) return;
    renaming.reset();
    removal.run(current);
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
              onEndEditing={rename}
              returnKeyType="done"
            />
          ) : (
            <SettingsRow key="name" title={current.name} />
          )}
        </SettingsGroup>
        <SettingsGroup>
          <SettingsRow
            key="members"
            accessibilityRole="button"
            title={t`Members`}
            // Alone in it, its owner is offered to invite someone instead of a count of one.
            value={
              current.memberCount === 1 && canManageOrganizationMembers(current)
                ? t`Invite people`
                : String(current.memberCount)
            }
            chevron="right"
            onPress={() =>
              router.push({
                pathname: "/organization-members",
                params: { organizationId: current.id },
              })
            }
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
                onPress={remove}
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
