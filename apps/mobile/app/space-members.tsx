import { MenuView } from "@expo/ui/community/menu";
import type { SpaceMember, SpaceMembers } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, Share, Text } from "react-native";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { cancelHeaderOptions, trailingHeaderOptions } from "../components/sheet-header";
import { rpc, selectedSpaceId, selectSpace } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";
import { errorText } from "../lib/user-error";

export default function SpaceMembersScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const appearance = useResolvedAppearance();
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
      // iOS shares a URL as a link; Android only takes text.
      await Share.share(Platform.OS === "ios" ? { url: link.url } : { message: link.url });
    } catch (err) {
      Alert.alert(t("Could not create invite link"), errorText(err, t("Try again.")));
    } finally {
      setPending(false);
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
      <Stack.Screen
        options={{
          ...cancelHeaderOptions(t("Close"), () => router.back()),
          ...(canManage ? trailingHeaderOptions(t("Invite"), () => void invite(), pending) : {}),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: native.groupedPage }}
        contentContainerStyle={{ padding: 20, gap: 28 }}
      >
        {error ? <Text style={{ color: tokens.destructive }}>{error}</Text> : null}
        {!members && !error ? <ActivityIndicator /> : null}
        {members ? (
          <SettingsGroup
            accessibilityLabel={t("Members")}
            footer={[
              t("Everyone in this space sees all its chats, bots and memory."),
              t("Your other spaces stay private."),
              t(
                "A bot uses the accounts of whoever messages it, and anyone here can read its reply.",
              ),
            ]
              .map((rule) => `• ${rule}`)
              .join("\n")}
          >
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
