import { MenuView } from "@expo/ui/community/menu";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { SpaceMember } from "@rakazo/contracts";
import { accountDisplay, spaceInvitee } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, Share, StyleSheet } from "react-native";
import { LoadFailure } from "../components/load-failure";
import { NativeSymbol } from "../components/native-symbol";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "../components/settings-group";
import { cancelHeaderOptions } from "../components/sheet-header";
import { selectedSpaceId } from "../lib/api";
import { selectSpace } from "../lib/api-server";
import { native, useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { targetRpcQuery, useSave } from "../lib/query";
import { useScreenQuery } from "../lib/screen-query";
import { settingsTarget } from "../lib/settings-target";
import { errorText } from "../lib/user-error";

/** The menu actions that share a link or email one instead of adding someone from the organization. */
const LINK_ACTION = "link";
const EMAIL_ACTION = "email";

export default function SpaceMembersScreen() {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const appearance = useResolvedAppearance();
  const tokens = useMobileTokens();
  const router = useRouter();
  const { spaceId, name } = useLocalSearchParams<{ spaceId: string; name?: string }>();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const membersRead = targetRpcQuery(target, "spaces/members/list", { spaceId });
  const membersQuery = useScreenQuery(membersRead, { enabled: Boolean(spaceId) });
  const members = membersQuery.data ?? null;
  /** The address being invited; null while its field is hidden. */
  const [email, setEmail] = useState<string | null>(null);
  // A retry clears the failure until it answers.
  const error =
    membersQuery.error && !membersQuery.isFetching
      ? errorText(membersQuery.error, t`Could not load members`)
      : null;
  const change = useSave({
    target,
    save: async (
      ask:
        | { kind: "invite" | "cancel" }
        | { kind: "remove" | "add"; userId: string }
        | { kind: "email"; email: string },
      send,
    ) => {
      if (ask.kind === "email") {
        return send("spaces/invites/create", { spaceId, email: ask.email });
      }
      if (ask.kind === "remove") {
        await send("spaces/members/remove", { spaceId, userId: ask.userId });
      } else if (ask.kind === "add") {
        await send("spaces/members/add", { spaceId, userId: ask.userId });
      } else if (ask.kind === "cancel") {
        await send("spaces/invites/cancel", { spaceId });
      } else {
        return send("spaces/invites/create", { spaceId });
      }
    },
    stale: [membersRead.queryKey],
    // Shared once the link exists and the list is read again, so a failed share hides nothing.
    onSaved: async (link, ask) => {
      if (ask.kind === "email") setEmail(null);
      if (!link || link.emailed) return;
      // iOS shares a URL as a link; Android only takes text.
      await Share.share(Platform.OS === "ios" ? { url: link.url } : { message: link.url }).catch(
        (err: unknown) =>
          Alert.alert(t`Could not create invite link`, errorText(err, t`Try again.`)),
      );
    },
    onFailed: (err, ask) =>
      Alert.alert(
        ask.kind === "remove"
          ? t`Could not remove member`
          : ask.kind === "add"
            ? t`Could not add member`
            : ask.kind === "cancel"
              ? t`Could not cancel invites`
              : ask.kind === "email"
                ? t`Could not invite`
                : t`Could not create invite link`,
        errorText(err, t`Try again.`),
      ),
  });
  const leaving = useSave({
    target,
    save: async (_, send) => {
      const result = await send("spaces/members/leave", { spaceId });
      if (selectedSpaceId() === spaceId) await selectSpace(result.activeSpaceId);
      router.dismissAll();
      router.replace("/");
    },
    onFailed: (err) => Alert.alert(t`Could not leave space`, errorText(err, t`Try again.`)),
    closesScreen: true,
  });
  const pending = change.pending || leaving.pending;

  function confirmRemove(member: SpaceMember, label: string) {
    Alert.alert(t`Remove ${ph({ name: label })}?`, undefined, [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Remove`,
        style: "destructive",
        onPress: () => {
          change.run({ kind: "remove", userId: member.userId });
        },
      },
    ]);
  }

  function confirmLeave() {
    Alert.alert(t`Leave ${ph({ name: name ?? members?.spaceName ?? "" })}?`, undefined, [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Leave`, style: "destructive", onPress: () => leaving.run() },
    ]);
  }

  const canManage = members?.canManage === true;
  const addable = members?.addable ?? [];
  const invitee = members && email !== null ? spaceInvitee(members, email) : null;

  function inviteByEmail() {
    if (!invitee || email === null || pending) return;
    if (invitee.kind === "outside") {
      change.run({ kind: "email", email: email.trim() });
      return;
    }
    // Someone in the organization joins directly, and someone already here needs nothing.
    if (invitee.kind === "addable") change.run({ kind: "add", userId: invitee.userId });
    setEmail(null);
  }
  const inviteRow = (
    <SettingsRow
      key="invite"
      title={t`Invite`}
      tinted
      leading={
        <NativeSymbol ios="person.badge.plus" android="person-add-outline" color={tokens.link} />
      }
      disabled={pending}
      accessibilityRole="button"
    />
  );
  return (
    <>
      <Stack.Screen options={cancelHeaderOptions(t`Close`, () => router.back())} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={styles.screen}
        contentContainerStyle={styles.content}
      >
        {error ? <LoadFailure message={error} onRetry={() => void membersQuery.refetch()} /> : null}
        {!members && !error ? <ActivityIndicator /> : null}
        {members ? (
          <SettingsGroup accessibilityLabel={t`Members`}>
            {members.members.map((member) => {
              const display = accountDisplay(member, member.email);
              const row = (
                <SettingsRow
                  key={member.userId}
                  title={display.label}
                  detail={display.label === member.email ? undefined : member.email}
                  value={
                    member.role === "owner" ? t`Owner` : member.guest ? t`External` : undefined
                  }
                  accessibilityActions={
                    canManage && member.role !== "owner"
                      ? [{ name: "remove", label: t`Remove` }]
                      : undefined
                  }
                  onAccessibilityAction={() => confirmRemove(member, display.label)}
                />
              );
              return canManage && member.role !== "owner" ? (
                <MenuView
                  key={member.userId}
                  shouldOpenOnLongPress
                  colorScheme={appearance}
                  actions={[
                    {
                      id: "remove",
                      title: t`Remove`,
                      image: "person.badge.minus",
                      attributes: { destructive: true },
                    },
                  ]}
                  onPressAction={() => confirmRemove(member, display.label)}
                >
                  {row}
                </MenuView>
              ) : (
                row
              );
            })}
            {canManage ? (
              // People already in the organization come first; an email or a link is for anyone
              // else.
              <MenuView
                key="invite"
                colorScheme={appearance}
                actions={[
                  ...addable.map((person) => ({
                    id: person.userId,
                    title: accountDisplay(person, person.email).label,
                  })),
                  { id: EMAIL_ACTION, title: t`Invite by email`, image: "envelope" as const },
                  { id: LINK_ACTION, title: t`Share invite link`, image: "link" as const },
                ].map((action) => ({ ...action, attributes: { disabled: pending } }))}
                onPressAction={({ nativeEvent }) =>
                  nativeEvent.event === EMAIL_ACTION
                    ? setEmail("")
                    : nativeEvent.event === LINK_ACTION
                      ? change.run({ kind: "invite" })
                      : change.run({ kind: "add", userId: nativeEvent.event })
                }
              >
                {inviteRow}
              </MenuView>
            ) : null}
          </SettingsGroup>
        ) : null}
        {canManage && email !== null ? (
          <SettingsGroup
            footer={
              invitee?.kind === "outside"
                ? t`Not in ${ph({ organization: members?.organizationName ?? "" })}. They'll only see this Space.`
                : undefined
            }
          >
            <SettingsInputRow
              key="email"
              accessibilityLabel={t`Email`}
              placeholder={t`Email`}
              autoFocus
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              returnKeyType="send"
              editable={!pending}
              value={email}
              onChangeText={setEmail}
              onSubmitEditing={inviteByEmail}
            />
            <SettingsRow
              key="send"
              title={t`Invite`}
              tinted
              disabled={pending || !invitee}
              dimmed={!invitee}
              accessibilityRole="button"
              onPress={inviteByEmail}
            />
          </SettingsGroup>
        ) : null}
        {canManage && members?.openInvites ? (
          <SettingsGroup>
            <SettingsRow
              key="cancel-invites"
              title={t`Cancel open invites`}
              destructive
              // A link still being created would outlive the cancel.
              disabled={pending}
              accessibilityRole="button"
              onPress={() => change.run({ kind: "cancel" })}
            />
          </SettingsGroup>
        ) : null}
        {members && !canManage ? (
          <SettingsGroup>
            <SettingsRow
              key="leave"
              title={t`Leave space`}
              destructive
              disabled={pending}
              accessibilityRole="button"
              onPress={confirmLeave}
            />
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 20, gap: 28 },
  });
}
