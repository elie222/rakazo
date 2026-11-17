import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { computerUpdates } from "../lib/computer-updates";
import { useSave } from "../lib/query";
import { errorText } from "../lib/user-error";
import { ConfirmDialog } from "./ConfirmDialog";

type Action = "recover" | "reset" | "restartScreen";

/**
 * The one repair a broken computer offers: rebuild its system where the computer can be updated
 * in place, and otherwise restore its last saved workspace. Shown only beside a failure. A running
 * Team computer also offers to restart just this bot's screen, which leaves the other bots alone.
 */
export function ComputerMaintenanceActions({
  botId,
  computer,
  onChanged,
}: {
  botId: string;
  computer: ComputerStatus | null;
  onChanged: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<Action | null>(null);
  const { t } = useLingui();
  const repair = useSave({
    save: async (action: Action, rpc) => {
      if (action === "recover")
        await computerUpdates.start(botId, "recover", (id) => rpc.computer.recover({ botId: id }));
      else if (action === "restartScreen") await rpc.computer.restartScreen({ botId });
      else await rpc.computer.reset({ botId });
      setConfirming(null);
      await onChanged();
    },
  });
  const pending = repair.pending;

  // The shared status can belong to another bot's open computer; acting on this bot needs its own.
  if (computer?.botId !== botId) return null;
  if (
    computer.state !== "error" &&
    computer.state !== "running" &&
    computer.state !== "suspended" &&
    computer.state !== "stopped"
  )
    return null;

  const busy = Boolean(computer.busyBotName);
  // A run waiting for a person to take over is not "busy", yet the restart refuses it too.
  const waitingForTakeover = computer.takeoverRequested === true;
  const action: Action = computer.canUpdate ? "recover" : "reset";
  // The restart is refused while another person holds control, so it is not offered then.
  const canRestartScreen =
    computer.mode === "team" &&
    computer.state === "running" &&
    computer.canRestartScreen === true &&
    !computer.controlledByOther;
  const asking = confirming ?? action;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || pending}
        onClick={() => {
          repair.reset();
          setConfirming(action);
        }}
      >
        {action === "recover" ? <Trans>Recover computer</Trans> : <Trans>Reset computer</Trans>}
      </Button>
      {canRestartScreen ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || waitingForTakeover || pending}
          onClick={() => {
            repair.reset();
            setConfirming("restartScreen");
          }}
        >
          <Trans>Restart screen</Trans>
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        onCancel={() => setConfirming(null)}
        title={
          asking === "restartScreen" ? (
            <Trans>Restart screen?</Trans>
          ) : asking === "recover" ? (
            <Trans>Recover computer?</Trans>
          ) : (
            <Trans>Reset computer?</Trans>
          )
        }
        description={
          asking === "restartScreen" ? (
            <Trans>Closes this bot's browser. Its saved sign-ins stay.</Trans>
          ) : asking === "recover" ? (
            <Trans>Recovery restores the last saved workspace. Unsaved work may be lost.</Trans>
          ) : (
            <Trans>Restore the last saved workspace. Unsaved work on the computer is lost.</Trans>
          )
        }
        error={repair.error ? errorText(repair.error, t`Could not update computer`) : null}
        confirmDisabled={pending}
        onConfirm={() => repair.run(asking)}
        confirmLabel={
          asking === "restartScreen" ? (
            pending ? (
              <Trans>Restarting…</Trans>
            ) : (
              <Trans>Restart</Trans>
            )
          ) : asking === "recover" ? (
            pending ? (
              <Trans>Recovering…</Trans>
            ) : (
              <Trans>Recover computer</Trans>
            )
          ) : pending ? (
            <Trans>Resetting…</Trans>
          ) : (
            <Trans>Reset</Trans>
          )
        }
      />
    </>
  );
}
