import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import type { ReactElement } from "react";
import { useCallback, useEffect } from "react";
import { Alert } from "react-native";
import { computerUpdates } from "../lib/computer-updates";
import { queryClient, rpcQuery, useSave } from "../lib/query";
import { errorText } from "../lib/user-error";
import { SettingsRow } from "./settings-group";

/** The one repair a bot's computer offers, and only while that computer is broken. */
export function useComputerMaintenanceRows(botId: string | undefined): ReactElement[] {
  const { t } = useLingui();
  const statusRead = rpcQuery("computer/status", { botId: botId ?? "" });
  const status = useQuery({ ...statusRead, enabled: Boolean(botId) }, queryClient);
  const { refetch } = status;
  // A stale status could offer an action the computer can no longer take.
  const computer = status.error ? null : status.data;

  useFocusEffect(
    useCallback(() => {
      if (botId) void refetch({ cancelRefetch: false });
    }, [botId, refetch]),
  );
  // A queued update or recovery reports progress here; its status changes with it.
  useEffect(
    () =>
      computerUpdates.subscribe(() => {
        if (botId) void refetch();
      }),
    [botId, refetch],
  );
  const repair = useSave({
    save: async ({ botId, action }: { botId: string; action: "reset" | "recover" }, send) => {
      if (action === "reset") await send("computer/reset", { botId });
      else
        await computerUpdates.start(botId, action, (id, step) =>
          send(`computer/${step}`, { botId: id }),
        );
    },
    stale: [statusRead.queryKey],
  });
  const error = repair.error ? errorText(repair.error, t`Could not update computer`) : null;

  if (!botId || !computer || computer.botId !== botId || computer.state !== "error") return [];
  const busy = Boolean(computer.busyBotName) || repair.pending;
  const pending = repair.pending;

  // Recover rebuilds the system where the computer can update in place; otherwise Reset
  // restores the last saved workspace.
  const action = computer.canUpdate ? "recover" : "reset";

  function run() {
    if (botId && !busy) repair.run({ botId, action });
  }

  return [
    <SettingsRow
      key="repair"
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      dimmed={busy}
      destructive
      title={
        action === "recover"
          ? pending
            ? t`Recovering…`
            : t`Recover computer`
          : pending
            ? t`Resetting…`
            : t`Reset computer`
      }
      onPress={() =>
        Alert.alert(
          action === "recover" ? t`Recover computer?` : t`Reset computer?`,
          action === "recover"
            ? t`Recovery restores the last saved workspace. Unsaved work may be lost.`
            : t`Restore the last saved workspace. Unsaved work on the computer is lost.`,
          [
            { text: t`Cancel`, style: "cancel" },
            {
              text: action === "recover" ? t`Recover computer` : t`Reset`,
              style: "destructive",
              onPress: run,
            },
          ],
        )
      }
    />,
    ...(error
      ? [<SettingsRow key="error" accessibilityRole="alert" destructive title={error} />]
      : []),
  ];
}
