import type { ComputerStatus } from "@rakazo/contracts";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { computerUpdates } from "../lib/computer-updates";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

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
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!computer) return null;

  const busy = Boolean(computer.busyBotName) || computer.state === "booting";

  async function run(action: Action) {
    setPending(action);
    setError(null);
    try {
      if (action === "recover") await computerUpdates.start(botId, "recover");
      else if (action === "reset") await rpc("computer/reset", { botId });
      else await computerUpdates.start(botId);
      await onChanged();
    } catch (err) {
      setError(errorText(err, t("Could not update computer")));
    } finally {
      setPending(null);
    }
  }

  function confirmReset() {
    Alert.alert(
      t("Reset computer?"),
      t("Restore the last saved workspace. Unsaved work on the computer is lost."),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Reset"), style: "destructive", onPress: () => void run("reset") },
      ],
    );
  }

  return (
    <View style={{ marginTop: 16, gap: 10 }}>
      <NativeActionButton
        label={pending === "recover" ? t("Recovering…") : t("Recover computer")}
        prominence="plain"
        disabled={busy || pending !== null}
        onPress={() => void run("recover")}
      />
      <NativeActionButton
        label={pending === "reset" ? t("Resetting…") : t("Reset computer")}
        prominence="destructive"
        fill={false}
        disabled={busy || pending !== null}
        onPress={confirmReset}
      />
      {computer.canUpdate ? (
        <NativeActionButton
          label={pending === "update" ? t("Updating…") : t("Update computer")}
          prominence="plain"
          disabled={busy || pending !== null}
          onPress={() => void run("update")}
        />
      ) : null}
      {error ? <Text style={{ color: tokens.destructive, fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}
