import { useLingui } from "@lingui/react/macro";
import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN, GROUP_NAME_MAX_LENGTH } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useContext, useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput } from "react-native";
import { BotMemberPicker } from "../components/bots/bot-member-picker";
import { glassHeaderOptions } from "../components/native/glass-title";
import { NativeActionButton } from "../components/native/native-action-button";
import { selectedSpaceId } from "../lib/api/api";
import type { MobileBot, MobileGroup } from "../lib/api/mobile-types";
import { errorText } from "../lib/api/user-error";
import { alertGroupNotDeleted, confirmDeleteGroup, deleteGroup } from "../lib/bots/bot-lifecycle";
import { CallKeyboardContext } from "../lib/calls/call-keyboard-context";
import {
  notifyArchivedChatsChanged,
  onArchivedChatsChanged,
} from "../lib/inbox/archived/archived-chats";
import { useSideInsets } from "../lib/layout/side-insets";
import { native, useMobileTokens } from "../lib/native/native";
import { formRead, queryClient, rpcQuery, useSave } from "../lib/query/query";
import type { SettingsTarget } from "../lib/query/settings-target";

export default function GroupSettingsScreen() {
  const rootAvoidsKeyboard = useContext(CallKeyboardContext);
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const router = useRouter();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  // The group belongs to the Space it was opened in; its reads and saves stay there.
  const [spaceId] = useState(() => selectedSpaceId() ?? undefined);
  const target: SettingsTarget | undefined = spaceId ? { scope: "space", spaceId } : undefined;
  const groupsQuery = useQuery(formRead(rpcQuery("groups/list", undefined, spaceId)), queryClient);
  const botsQuery = useQuery(formRead(rpcQuery("bots/list", undefined, spaceId)), queryClient);
  const { refetch: refetchGroups } = groupsQuery;
  const { refetch: refetchBots } = botsQuery;
  const [group, setGroup] = useState<MobileGroup | null>(null);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [name, setName] = useState("");
  const deselected = useRef(new Set<string>());
  // The group as last read, which edits made since are kept over.
  const baseline = useRef<MobileGroup | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [missing, setMissing] = useState(false);
  const readError = groupsQuery.error ?? botsQuery.error;
  const loadError = readError
    ? errorText(readError, t`Could not load group`)
    : missing
      ? t`Group not found`
      : null;

  useEffect(
    () =>
      onArchivedChatsChanged(() => {
        // A change in another selected Space is not this group's.
        if ((selectedSpaceId() ?? undefined) !== spaceId) return;
        void refetchGroups();
        void refetchBots();
      }),
    [spaceId, refetchGroups, refetchBots],
  );

  useEffect(() => {
    // Only what this visit read: a copy an earlier one left is not the group as it is now.
    const groups = groupsQuery.isFetchedAfterMount ? groupsQuery.data : undefined;
    const nextBots = botsQuery.isFetchedAfterMount ? botsQuery.data : undefined;
    if (!groups || !nextBots) return;
    const nextGroup = groups.find((row) => row.id === groupId);
    setMissing(!nextGroup);
    if (!nextGroup) {
      baseline.current = null;
      setGroup(null);
      return;
    }
    const ids = new Set([
      ...nextBots.map((bot) => bot.id),
      ...nextGroup.members.map((member) => member.botId),
    ]);
    const previous = baseline.current;
    const previousMembers = new Set(previous?.members.map((member) => member.botId));
    // Another group opened in place starts from its own read, not the previous group's edits.
    const initial = previous?.id !== nextGroup.id;
    if (initial) deselected.current.clear();
    const previousName = previous?.name;
    baseline.current = nextGroup;
    setGroup(nextGroup);
    setName((current) => (initial || current === previousName ? nextGroup.name : current));
    setSelected((current) =>
      initial
        ? nextGroup.members.map((member) => member.botId)
        : [
            ...new Set([
              ...nextGroup.members
                .filter(
                  (member) =>
                    !deselected.current.has(member.botId) &&
                    (!previousMembers.has(member.botId) || current.includes(member.botId)),
                )
                .map((member) => member.botId),
              ...current.filter((id) => !previousMembers.has(id) && ids.has(id)),
            ]),
          ],
    );
    setBots(nextBots.filter((bot) => !bot.archivedAt));
  }, [
    groupsQuery.isFetchedAfterMount,
    groupsQuery.data,
    botsQuery.isFetchedAfterMount,
    botsQuery.data,
    groupId,
  ]);

  const saving = useSave({
    target,
    save: async (
      input: { groupId: string; name?: string; botIds?: string[]; expectedBotIds?: string[] },
      send,
    ) => {
      if (input.name || input.botIds) await send("groups/update", input);
    },
    onSaved: () => router.back(),
    closesScreen: true,
  });
  const pending = saving.pending;
  const error = saving.error ? errorText(saving.error, t`Could not save group`) : null;
  const removal = useSave({
    target,
    save: async (removedId: string, send) => {
      await deleteGroup(removedId, send);
      notifyArchivedChatsChanged();
    },
    onSaved: () => router.replace("/"),
    onFailed: alertGroupNotDeleted,
    closesScreen: true,
  });

  function save() {
    if (!groupId || !group) return;
    const input: {
      groupId: string;
      name?: string;
      botIds?: string[];
      expectedBotIds?: string[];
    } = { groupId };
    if (name.trim() !== group.name) input.name = name.trim();
    const memberIds = group.members.map((member) => member.botId).join(",");
    if (selected.join(",") !== memberIds) {
      input.botIds = selected;
      input.expectedBotIds = group.members.map((member) => member.botId);
    }
    saving.run(input);
  }

  function remove() {
    if (groupId && group) confirmDeleteGroup(group, () => removal.run(groupId));
  }

  return (
    <>
      <Stack.Screen options={glassHeaderOptions(t`Group settings`)} />
      <ScrollView
        style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
        contentContainerStyle={{ padding: 24 }}
        automaticallyAdjustKeyboardInsets={!rootAvoidsKeyboard}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t`Name`}</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          maxLength={GROUP_NAME_MAX_LENGTH}
          placeholder={t`Group name`}
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
        {group ? (
          <BotMemberPicker
            key={group.id}
            bots={bots}
            selected={selected}
            onChange={(next) => {
              for (const id of selected) {
                if (!next.includes(id)) deselected.current.add(id);
              }
              for (const id of next) deselected.current.delete(id);
              setSelected(next);
            }}
            onOpenBot={(bot) =>
              router.push({ pathname: "/bot-profile", params: { botId: bot.id, name: bot.name } })
            }
            disabled={pending}
          />
        ) : null}
        {error || loadError ? (
          <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error ?? loadError}</Text>
        ) : null}
        <NativeActionButton
          disabled={
            !name.trim() ||
            selected.length < GROUP_MEMBER_MIN ||
            selected.length > GROUP_MEMBER_MAX ||
            pending
          }
          label={pending ? t`Saving…` : t`Save`}
          onPress={save}
          style={{ marginTop: 24 }}
        />
        {groupId ? (
          <NativeActionButton
            label={t`Pages`}
            onPress={() => router.push({ pathname: "/pages", params: { groupId } })}
            style={{ marginTop: 16 }}
          />
        ) : null}
        <NativeActionButton
          label={t`Delete group`}
          onPress={remove}
          prominence="destructive"
          style={{ marginTop: 16 }}
        />
      </ScrollView>
    </>
  );
}
