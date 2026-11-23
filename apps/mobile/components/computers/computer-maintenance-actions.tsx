import { useLingui } from "@lingui/react/macro";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { selectedSpaceId } from "../../lib/api/api";
import { errorText } from "../../lib/api/user-error";
import { computerUpdates } from "../../lib/computers/computer-updates";
import { rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { SettingsRow } from "../settings/settings-group";

/** The one repair a bot's computer offers, and only while that computer is broken. */
export function useComputerMaintenanceRows(botId: string | undefined): ReactElement[] {
  const { t } = useLingui();
  // The bot's own Space, the one selected when its settings opened, whatever is selected later.
  const [spaceId] = useState(() => selectedSpaceId() ?? undefined);
  const statusRead = rpcQuery("computer/status", { botId: botId ?? "" }, spaceId);
  const status = useScreenQuery(statusRead, { enabled: Boolean(botId), onForeground: false });
  const { refetch } = status;
  // A stale status could offer an action the computer can no longer take.
  const computer = status.error ? null : status.data;

  // A queued update or recovery reports progress here; its status changes with it.
  useEffect(
    () =>
      computerUpdates.subscribe(() => {
        if (botId) void refetch();
      }),
    [botId, refetch],
  );
  const repair = useSave({
    target: spaceId ? { scope: "space", spaceId } : undefined,
    save: async ({ botId, action }: { botId: string; action: "reset" | "recover" }, send) => {
      if (action === "reset") await send("computer/reset", { botId });
      // Progress is shown for the selected Space only; another Space's repair is sent on its own.
      else if (spaceId !== (selectedSpaceId() ?? undefined))
        await send("computer/recover", { botId });
      else
        await computerUpdates.start(botId, action, (id, step) =>
          send(`computer/${step}`, { botId: id }),
        );
    },
    stale: [statusRead.queryKey],
  });
  const error = repair.error ? errorText(repair.error, t`Could not update computer`) : null;

  // A status from an earlier visit is never repaired from: the computer may have recovered since.
  if (!status.isFetchedAfterMount) return [];
  if (!botId || !computer || computer.botId !== botId || computer.state !== "error") return [];
  // While the status is read again, it may no longer be broken.
  const busy = Boolean(computer.busyBotName) || repair.pending || status.isFetching;
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
