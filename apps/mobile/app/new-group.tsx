import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@rakazo/contracts";
import { Stack, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { type MobileBot, rpc } from "../lib/api";

export default function NewGroup() {
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

  function toggle(botId: string) {
    setSelected((current) => {
      if (current.includes(botId)) return current.filter((id) => id !== botId);
      if (current.length >= GROUP_MEMBER_MAX) return current;
      return [...current, botId];
    });
  }

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
      setError(err instanceof Error ? err.message : "Could not create group");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: "New group" }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: "#050506" }}
        contentContainerStyle={{ padding: 24 }}
      >
        <Text style={{ color: "#85858A", fontSize: 14 }}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Name this group"
          placeholderTextColor="#6C6C70"
          style={{
            marginTop: 8,
            backgroundColor: "#1A1A1D",
            borderRadius: 11,
            padding: 14,
            color: "#ECECEE",
            fontSize: 16,
          }}
        />
        <Text style={{ color: "#85858A", fontSize: 14, marginTop: 20 }}>
          Members ({GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX})
        </Text>
        {bots.map((bot) => {
          const checked = selected.includes(bot.id);
          return (
            <Pressable
              key={bot.id}
              onPress={() => toggle(bot.id)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingVertical: 12,
              }}
            >
              <BotAvatar color={bot.color} identity={bot.id} size={34} status={bot.status} />
              <Text style={{ flex: 1, color: "#ECECEE", fontSize: 16 }}>{bot.name}</Text>
              <Text style={{ color: "#6C6C70" }}>{checked ? "✓" : ""}</Text>
            </Pressable>
          );
        })}
        {error ? <Text style={{ color: "#FF6B6B", marginTop: 12 }}>{error}</Text> : null}
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
            backgroundColor: "#8B5CF6",
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
          <Text style={{ color: "#FFF", fontSize: 16, fontWeight: "600" }}>
            {pending ? "Creating…" : "Create group"}
          </Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
