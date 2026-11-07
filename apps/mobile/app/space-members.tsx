import { MenuView } from "@expo/ui/community/menu";
import type { SpaceMember, SpaceMembers } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
} from "react-native";
import { NativeSymbol } from "../components/native-symbol";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { cancelHeaderOptions } from "../components/sheet-header";
import { rpc, selectedSpaceId } from "../lib/api";
import { selectSpace } from "../lib/api-server";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";

export default function SpaceMembersScreen() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const appearance = useResolvedAppearance();
  const tokens = useMobileTokens();
  const router = useRouter();
  const { spaceId, name } = useLocalSearchParams<{ spaceId: string; name?: string }>();
  const [members, setMembers] = useState<SpaceMembers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!spaceId) return;
    let active = true;
    rpc("spaces/members/list", { spaceId })
      .then((next) => {
        if (active) setMembers(next);
      })
      .catch((err: unknown) => {
        if (active) setError(errorText(err, t("Could not load members")));
      });
    return () => {
      active = false;
    };
  }, [spaceId]);

  async function invite() {
    if (!spaceId || pending) return;
    setPending(true);
    try {
      const link = await rpc("spaces/invites/create", { spaceId });
      setMembers((current) =>
        current ? { ...current, openInvites: (current.openInvites ?? 0) + 1 } : current,
      );
      // iOS shares a URL as a link; Android only takes text.
      await Share.share(Platform.OS === "ios" ? { url: link.url } : { message: link.url });
    } catch (err) {
      Alert.alert(t("Could not create invite link"), errorText(err, t("Try again.")));
    } finally {
      setPending(false);
    }
  }

  async function cancelInvites() {
    if (!spaceId) return;
    try {
      await rpc("spaces/invites/cancel", { spaceId });
      setMembers((current) => (current ? { ...current, openInvites: 0 } : current));
    } catch (err) {
      Alert.alert(t("Could not cancel invites"), errorText(err, t("Try again.")));
    }
  }

  function confirmRemove(member: SpaceMember, label: string) {
    Alert.alert(t("Remove {name}?", { name: label }), undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Remove"),
        style: "destructive",
        onPress: () => {
          void rpc("spaces/members/remove", { spaceId, userId: member.userId })
            .then(() =>
              setMembers((current) =>
                current
                  ? {
                      ...current,
                      members: current.members.filter((item) => item.userId !== member.userId),
                    }
                  : current,
              ),
            )
            .catch((err: unknown) =>
              Alert.alert(t("Could not remove member"), errorText(err, t("Try again."))),
            );
        },
      },
    ]);
  }

  function confirmLeave() {
    Alert.alert(t("Leave {name}?", { name: name ?? members?.spaceName ?? "" }), undefined, [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Leave"), style: "destructive", onPress: () => void leave() },
    ]);
  }

  async function leave() {
    if (!spaceId || pending) return;
    setPending(true);
    try {
      const result = await rpc("spaces/members/leave", { spaceId });
      if (selectedSpaceId() === spaceId) await selectSpace(result.activeSpaceId);
      router.dismissAll();
      router.replace("/");
    } catch (err) {
      Alert.alert(t("Could not leave space"), errorText(err, t("Try again.")));
      setPending(false);
    }
  }

  const canManage = members?.canManage === true;
  return (
    <>
      <Stack.Screen options={cancelHeaderOptions(t("Close"), () => router.back())} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={styles.screen}
        contentContainerStyle={styles.content}
      >
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!members && !error ? <ActivityIndicator /> : null}
        {members ? (
          <SettingsGroup accessibilityLabel={t("Members")}>
            {members.members.map((member) => {
              const display = accountDisplay(member, member.email);
              const row = (
                <SettingsRow
                  key={member.userId}
                  title={display.label}
                  detail={display.label === member.email ? undefined : member.email}
                  value={member.role === "owner" ? t("Owner") : undefined}
                  accessibilityActions={
                    canManage && member.role !== "owner"
                      ? [{ name: "remove", label: t("Remove") }]
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
                      title: t("Remove"),
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
              <SettingsRow
                key="invite"
                title={t("Invite")}
                tinted
                leading={
                  <NativeSymbol
                    ios="person.badge.plus"
                    android="person-add-outline"
                    color={tokens.link}
                  />
                }
                disabled={pending}
                accessibilityRole="button"
                onPress={() => void invite()}
              />
            ) : null}
          </SettingsGroup>
        ) : null}
        {canManage && members?.openInvites ? (
          <SettingsGroup>
            <SettingsRow
              key="cancel-invites"
              title={t("Cancel open invites")}
              destructive
              // A link still being created would outlive the cancel.
              disabled={pending}
              accessibilityRole="button"
              onPress={() => void cancelInvites()}
            />
          </SettingsGroup>
        ) : null}
        {members && !canManage ? (
          <SettingsGroup>
            <SettingsRow
              key="leave"
              title={t("Leave space")}
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
    error: { color: mobileTokens().destructive },
  });
}
