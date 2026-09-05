import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@rakazo/contracts";
import { Stack, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput } from "react-native";
import { BotMemberPicker } from "../components/bot-member-picker";
import { type MobileBot, rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export default function NewGroup() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void rpc<MobileBot[]>("bots/list")
      .then((nextBots) => setBots(nextBots.filter((bot) => !bot.archivedAt)))
      .catch(() => undefined);
  }, []);

  async function create() {
    if (
      !name.trim() ||
      selected.length < GROUP_MEMBER_MIN ||
      selected.length > GROUP_MEMBER_MAX ||
      pending
    )
      return;
    setPending(true);
    setError(null);
    try {
      const group = await rpc<{ id: string; name: string }>("groups/create", {
        name: name.trim(),
        botIds: selected,
      });
      router.replace({
        pathname: "/group-thread",
        params: { groupId: group.id, name: group.name },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not create group"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: t("New group") }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t("Name this group")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 14,
            color: tokens.foreground,
            fontSize: 16,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, fontSize: 14, marginTop: 20 }}>
          {t("Members")}
        </Text>
        <BotMemberPicker
          bots={bots}
          selected={selected}
          onChange={setSelected}
          disabled={pending}
        />
        {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
        <Pressable
          onPress={() => void create()}
          disabled={
            !name.trim() ||
            selected.length < GROUP_MEMBER_MIN ||
            selected.length > GROUP_MEMBER_MAX ||
            pending
          }
          style={{
            marginTop: 24,
            backgroundColor: tokens.primary,
            opacity:
              !name.trim() ||
              selected.length < GROUP_MEMBER_MIN ||
              selected.length > GROUP_MEMBER_MAX ||
              pending
                ? 0.5
                : 1,
            borderRadius: 11,
            padding: 14,
            alignItems: "center",
          }}
        >
          <Text style={{ color: tokens.primaryForeground, fontSize: 16, fontWeight: "600" }}>
            {pending ? t("Creating…") : t("Create group")}
          </Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
