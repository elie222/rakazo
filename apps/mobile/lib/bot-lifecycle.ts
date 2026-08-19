import { Alert } from "react-native";
import { rpc } from "./api";

export function confirmDeleteBot(bot: { id: string; name: string }, onDeleted: () => void) {
  const remove = async (deleteMemories: boolean) => {
    try {
      await rpc("bots/remove", { botId: bot.id, deleteMemories });
      onDeleted();
    } catch (error) {
      Alert.alert("Could not delete bot", error instanceof Error ? error.message : "Try again.");
    }
  };

  Alert.alert(
    `Delete ${bot.name}?`,
    "Its conversation, files, and routines will be permanently deleted. What should happen to its memories?",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Keep memories", onPress: () => void remove(false) },
      {
        text: "Delete memories too",
        style: "destructive",
        onPress: () => void remove(true),
      },
    ],
  );
}
