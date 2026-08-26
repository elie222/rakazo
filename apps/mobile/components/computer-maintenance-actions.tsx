import type { ComputerStatus } from "@rakazo/contracts";
import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { rpc } from "../lib/api";

type Action = "recover" | "reset" | "update";

export function ComputerMaintenanceActions({
  botId,
  computer,
  onChanged,
}: {
  botId: string;
  computer: ComputerStatus | null;
  onChanged: () => Promise<void>;
}) {
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!computer) return null;

  const busy = Boolean(computer.busyBotName) || computer.state === "booting";

  async function run(action: Action) {
    setPending(action);
    setError(null);
    try {
      if (action === "recover") await rpc("computer/recover", { botId });
      else if (action === "reset") await rpc("computer/reset", { botId });
      else await rpc("computer/update", { botId });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update computer");
    } finally {
      setPending(null);
    }
  }

  function confirmReset() {
    Alert.alert(
      "Reset computer?",
      "Restore the last saved workspace. Unsaved work on the computer is lost.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Reset", style: "destructive", onPress: () => void run("reset") },
      ],
    );
  }

  return (
    <View style={{ marginTop: 16, gap: 10 }}>
      <Pressable
        disabled={busy || pending !== null}
        onPress={() => void run("recover")}
        style={{ opacity: busy || pending !== null ? 0.4 : 1 }}
      >
        <Text style={{ color: "#85858A", fontSize: 14 }}>
          {pending === "recover" ? "Recovering…" : "Recover computer"}
        </Text>
      </Pressable>
      <Pressable
        disabled={busy || pending !== null}
        onPress={confirmReset}
        style={{ opacity: busy || pending !== null ? 0.4 : 1 }}
      >
        <Text style={{ color: "#85858A", fontSize: 14 }}>
          {pending === "reset" ? "Resetting…" : "Reset computer"}
        </Text>
      </Pressable>
      {computer.updateAvailable ? (
        <Pressable
          disabled={busy || pending !== null}
          onPress={() => void run("update")}
          style={{ opacity: busy || pending !== null ? 0.4 : 1 }}
        >
          <Text style={{ color: "#85858A", fontSize: 14 }}>
            {pending === "update" ? "Updating…" : "Update computer"}
          </Text>
        </Pressable>
      ) : null}
      {error ? <Text style={{ color: "#E65707", fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}
