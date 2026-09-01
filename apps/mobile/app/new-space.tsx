import type { Space } from "@rakazo/contracts";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { rpc, selectSpace } from "../lib/api";

export default function NewSpace() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const space = await rpc<Space>("spaces/create", { name: trimmed });
      if (!(await selectSpace(space.id))) {
        Alert.alert("Space created", "It could not be opened. Try again from the sidebar.");
        router.dismissAll();
        router.replace("/");
        return;
      }
      router.dismissAll();
      router.replace("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create space");
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={{ color: "#0A84FF", fontSize: 17 }}>Cancel</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: "#050506" }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={{
            borderWidth: 1,
            borderColor: "#343438",
            borderRadius: 16,
            backgroundColor: "#1A1A1D",
            padding: 18,
          }}
        >
          <Text style={{ color: "#F1F1F2", fontSize: 18, fontWeight: "600" }}>Space</Text>
          <Text style={{ color: "#85858A", fontSize: 14, marginTop: 20 }}>Name</Text>
          <TextInput
            autoFocus
            value={name}
            maxLength={60}
            onChangeText={setName}
            onSubmitEditing={() => void create()}
            placeholder="Customer support"
            placeholderTextColor="#6C6C70"
            returnKeyType="done"
            style={{
              marginTop: 8,
              backgroundColor: "#101012",
              borderRadius: 11,
              padding: 14,
              color: "#ECECEE",
              fontSize: 16,
            }}
          />
          {error ? <Text style={{ color: "#EF4444", marginTop: 14 }}>{error}</Text> : null}
          <Pressable
            onPress={() => void create()}
            disabled={!name.trim() || pending}
            style={{
              marginTop: 20,
              backgroundColor: "#8B5CF6",
              borderRadius: 999,
              padding: 14,
              alignItems: "center",
              opacity: !name.trim() || pending ? 0.4 : 1,
            }}
          >
            <Text style={{ color: "#090A12", fontSize: 16, fontWeight: "600" }}>
              {pending ? "Creating…" : "Create space"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </>
  );
}
