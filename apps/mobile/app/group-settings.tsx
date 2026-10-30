import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN, GROUP_NAME_MAX_LENGTH } from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput } from "react-native";
import { BotMemberPicker } from "../components/bot-member-picker";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import type { MobileBot, MobileGroup } from "../lib/api";
import { rpc } from "../lib/api";
import { notifyArchivedChatsChanged } from "../lib/archived-chats";
import { confirmDeleteGroup } from "../lib/bot-lifecycle";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function GroupSettingsScreen() {
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const [group, setGroup] = useState<MobileGroup | null>(null);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!groupId) return;
    void Promise.all([
      rpc("groups/list").then((groups) => groups.find((row) => row.id === groupId) ?? null),
      rpc("bots/list"),
    ])
      .then(([nextGroup, nextBots]) => {
        if (!nextGroup) throw new Error(t("Group not found"));
        setGroup(nextGroup);
        setName(nextGroup.name);
        setSelected(nextGroup.members.map((member) => member.botId));
        setBots(nextBots.filter((bot) => !bot.archivedAt));
      })
      .catch((err) => setError(errorText(err, t("Could not load group"))));
  }, [groupId]);

  async function save() {
    if (!groupId || !group || pending) return;
    setPending(true);
    setError(null);
    try {
      const input: { groupId: string; name?: string; botIds?: string[] } = { groupId };
      if (name.trim() !== group.name) input.name = name.trim();
      const memberIds = group.members.map((member) => member.botId).join(",");
      if (selected.join(",") !== memberIds) input.botIds = selected;
      if (input.name || input.botIds) await rpc("groups/update", input);
      router.back();
    } catch (err) {
      setError(errorText(err, t("Could not save group")));
    } finally {
      setPending(false);
    }
  }

  function remove() {
    if (!groupId || !group) return;
    confirmDeleteGroup({ id: groupId, name: group.name }, () => {
      notifyArchivedChatsChanged();
      router.replace("/");
    });
  }

  return (
    <>
      <Stack.Screen options={glassHeaderOptions(t("Group settings"))} />
      <ScrollView
        style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
        contentContainerStyle={{ padding: 24 }}
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          maxLength={GROUP_NAME_MAX_LENGTH}
          placeholder={t("Group name")}
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
            onChange={setSelected}
            onOpenBot={(bot) =>
              router.push({ pathname: "/bot-profile", params: { botId: bot.id, name: bot.name } })
            }
            disabled={pending}
          />
        ) : null}
        {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
        <NativeActionButton
          disabled={
            !name.trim() ||
            selected.length < GROUP_MEMBER_MIN ||
            selected.length > GROUP_MEMBER_MAX ||
            pending
          }
          label={pending ? t("Saving…") : t("Save")}
          onPress={() => void save()}
          style={{ marginTop: 24 }}
        />
        <NativeActionButton
          label={t("Delete group")}
          onPress={remove}
          prominence="destructive"
          style={{ marginTop: 16 }}
        />
      </ScrollView>
    </>
  );
}
