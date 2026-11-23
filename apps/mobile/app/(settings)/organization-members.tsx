import { MenuView } from "@expo/ui/community/menu";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { OrganizationInvitation, OrganizationMember } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import { useIsFocused, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, Share, StyleSheet } from "react-native";
import { NativeSymbol } from "../../components/native/native-symbol";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsRow,
} from "../../components/settings/settings-group";
import { LoadFailure } from "../../components/ui/load-failure";
import { useLiveStream } from "../../lib/api/roster-signals";
import { errorText } from "../../lib/api/user-error";
import { useSideInsets } from "../../lib/layout/side-insets";
import {
  native,
  useMobileTokens,
  useResolvedAppearance,
  useThemedStyles,
} from "../../lib/native/native";
import { targetRpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { ACCOUNT_SETTINGS } from "../../lib/query/settings-target";
import { refreshOrganizations } from "../../lib/spaces/organizations";

type Change =
  | { kind: "invite"; email: string }
  | { kind: "role"; member: OrganizationMember; role: "admin" | "member" }
  | { kind: "remove"; member: OrganizationMember }
  | { kind: "cancel"; invitation: OrganizationInvitation };

/** Everyone in the organization; its owner and admins also invite, change roles and remove. */
export default function OrganizationMembersScreen() {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const appearance = useResolvedAppearance();
  const sideInsets = useSideInsets();
  const { organizationId } = useLocalSearchParams<{ organizationId: string }>();
  const read = targetRpcQuery(ACCOUNT_SETTINGS, "organizations/members/list", { organizationId });
  const query = useScreenQuery(read, { enabled: Boolean(organizationId) });
  // Someone else's change to the members reaches this screen as a signal on the live stream.
  useLiveStream(useIsFocused());
  const members = query.data ?? null;
  const [email, setEmail] = useState("");
  const loadError =
    query.error && !query.isFetching ? errorText(query.error, t`Could not load members`) : null;

  const change = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (ask: Change, send) => {
      if (ask.kind === "invite") {
        return send("organizations/invitations/create", { organizationId, email: ask.email });
      }
      if (ask.kind === "cancel") {
        await send("organizations/invitations/cancel", {
          organizationId,
          invitationId: ask.invitation.id,
        });
      } else if (ask.kind === "remove") {
        await send("organizations/members/remove", { organizationId, userId: ask.member.userId });
      } else {
        await send("organizations/members/setRole", {
          organizationId,
          userId: ask.member.userId,
          role: ask.role,
        });
      }
      // The member count shows on the Organization screen.
      await refreshOrganizations();
    },
    stale: [read.queryKey],
    onSaved: async (sent, ask) => {
      if (ask.kind !== "invite" || !sent) return;
      setEmail("");
      // Without an email from this server, the link goes to them by hand.
      if (!sent.emailed) await shareLink(sent.url);
    },
    onFailed: (err, ask) =>
      Alert.alert(
        ask.kind === "invite"
          ? t`Could not invite`
          : ask.kind === "remove"
            ? t`Could not remove member`
            : ask.kind === "cancel"
              ? t`Could not cancel invitation`
              : t`Could not change role`,
        errorText(err, t`Try again.`),
      ),
  });

  async function shareLink(url: string) {
    // iOS shares a URL as a link; Android only takes text.
    await Share.share(Platform.OS === "ios" ? { url } : { message: url }).catch((err: unknown) =>
      Alert.alert(t`Could not share invite link`, errorText(err, t`Try again.`)),
    );
  }

  function invite() {
    const address = email.trim();
    if (address && !change.pending) change.run({ kind: "invite", email: address });
  }

  function confirmRemove(member: OrganizationMember, label: string) {
    Alert.alert(t`Remove ${ph({ name: label })}?`, t`Spaces only they use pass to you.`, [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Remove`,
        style: "destructive",
        onPress: () => change.run({ kind: "remove", member }),
      },
    ]);
  }

  const canManage = members?.canManage === true;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      style={[styles.screen, sideInsets]}
      contentContainerStyle={styles.content}
    >
      {loadError ? <LoadFailure message={loadError} onRetry={() => void query.refetch()} /> : null}
      {!members && !loadError ? <ActivityIndicator color={native.secondaryLabel} /> : null}
      {canManage ? (
        <SettingsGroup>
          <SettingsInputRow
            key="email"
            accessibilityLabel={t`Email`}
            placeholder={t`Email`}
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="send"
            editable={!change.pending}
            value={email}
            onChangeText={setEmail}
            onSubmitEditing={invite}
          />
          <SettingsRow
            key="invite"
            title={t`Invite`}
            tinted
            leading={
              <NativeSymbol
                ios="person.badge.plus"
                android="person-add-outline"
                color={tokens.link}
              />
            }
            disabled={change.pending || !email.trim()}
            dimmed={!email.trim()}
            accessibilityRole="button"
            onPress={invite}
          />
        </SettingsGroup>
      ) : null}
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
                  member.role === "owner"
                    ? t`Owner`
                    : member.role === "admin"
                      ? t`Admin`
                      : undefined
                }
              />
            );
            if (!member.manageable) return row;
            const roleTitle = member.role === "admin" ? t`Make member` : t`Make admin`;
            const nextRole = member.role === "admin" ? "member" : "admin";
            return (
              <MenuView
                key={member.userId}
                shouldOpenOnLongPress
                colorScheme={appearance}
                actions={[
                  ...(member.roleChangeable
                    ? [{ id: "role", title: roleTitle, image: "person.badge.key" as const }]
                    : []),
                  {
                    id: "remove",
                    title: t`Remove`,
                    image: "person.badge.minus" as const,
                    attributes: { destructive: true },
                  },
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "remove") confirmRemove(member, display.label);
                  else change.run({ kind: "role", member, role: nextRole });
                }}
              >
                <SettingsRow
                  title={display.label}
                  detail={display.label === member.email ? undefined : member.email}
                  value={member.role === "admin" ? t`Admin` : undefined}
                  accessibilityActions={[
                    ...(member.roleChangeable ? [{ name: "role", label: roleTitle }] : []),
                    { name: "remove", label: t`Remove` },
                  ]}
                  onAccessibilityAction={({ nativeEvent }) => {
                    if (nativeEvent.actionName === "remove") confirmRemove(member, display.label);
                    else change.run({ kind: "role", member, role: nextRole });
                  }}
                />
              </MenuView>
            );
          })}
          {members.invitations.map((invitation) => (
            <MenuView
              key={invitation.id}
              shouldOpenOnLongPress
              colorScheme={appearance}
              actions={[
                { id: "share", title: t`Share invite link`, image: "square.and.arrow.up" },
                {
                  id: "cancel",
                  title: t`Cancel invitation`,
                  image: "xmark",
                  attributes: { destructive: true },
                },
              ]}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "cancel") change.run({ kind: "cancel", invitation });
                else void shareLink(invitation.url);
              }}
            >
              <SettingsRow
                title={invitation.email}
                value={t`Invited`}
                accessibilityActions={[
                  { name: "share", label: t`Share invite link` },
                  { name: "cancel", label: t`Cancel invitation` },
                ]}
                onAccessibilityAction={({ nativeEvent }) => {
                  if (nativeEvent.actionName === "cancel")
                    change.run({ kind: "cancel", invitation });
                  else void shareLink(invitation.url);
                }}
              />
            </MenuView>
          ))}
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
  });
}
