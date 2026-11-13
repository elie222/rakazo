import { useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { rpc } from "../lib/api";
import { computerUpdates } from "../lib/computer-updates";
import { errorText } from "../lib/user-error";
import { SettingsRow } from "./settings-group";

/** Update and Reset rows for a bot's Computer settings group. */
export function useComputerMaintenanceRows(botId: string | undefined): ReactElement[] {
  const { t } = useLingui();
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [pending, setPending] = useState<"reset" | "update" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const latestRead = useRef(0);
  const refresh = useCallback(async () => {
    const read = ++latestRead.current;
    if (!botId) return;
    // A stale status could offer an action the computer can no longer take.
    const next = await rpc("computer/status", { botId }).catch(() => null);
    if (read === latestRead.current) setComputer(next);
  }, [botId]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  // A queued update or recovery reports progress here; its status changes with it.
  useEffect(() => computerUpdates.subscribe(() => void refresh()), [refresh]);

  if (!botId || !computer || computer.botId !== botId) return [];
  const busy = Boolean(computer.busyBotName) || computer.state === "booting" || pending !== null;

  async function run(action: "reset" | "update") {
    if (!botId || busy) return;
    setPending(action);
    setError(null);
    try {
      if (action === "reset") await rpc("computer/reset", { botId });
      else await computerUpdates.start(botId);
      await refresh();
    } catch (err) {
      setError(errorText(err, t`Could not update computer`));
    } finally {
      setPending(null);
    }
  }

  return [
    ...(computer.canUpdate
      ? [
          <SettingsRow
            key="update"
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            dimmed={busy}
            title={pending === "update" ? t`Updating…` : t`Update computer`}
            onPress={() => void run("update")}
          />,
        ]
      : []),
    <SettingsRow
      key="reset"
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      dimmed={busy}
      destructive
      title={pending === "reset" ? t`Resetting…` : t`Reset computer`}
      onPress={() =>
        Alert.alert(
          t`Reset computer?`,
          t`Restore the last saved workspace. Unsaved work on the computer is lost.`,
          [
            { text: t`Cancel`, style: "cancel" },
            { text: t`Reset`, style: "destructive", onPress: () => void run("reset") },
          ],
        )
      }
    />,
    ...(error
      ? [<SettingsRow key="error" accessibilityRole="alert" destructive title={error} />]
      : []),
  ];
}
