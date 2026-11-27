import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { computerUpdates } from "../../lib/computers/computer-updates";
import { useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { ConfirmDialog } from "../ConfirmDialog";

type Action = "recover" | "reset";

/**
 * The repair controls for a computer: optionally restart just this bot's screen without resetting
 * a shared Team computer, and rebuild or restore the workspace beside a failure.
 */
export function ComputerMaintenanceActions({
  botId,
  computer,
  onChanged,
  allowRestartScreen = false,
  allowReset = true,
}: {
  botId: string;
  computer: ComputerStatus | null;
  onChanged: () => Promise<void>;
  /** Offers a non-destructive single-bot screen restart while the computer is running. */
  allowRestartScreen?: boolean;
  /** Set false on a running computer so screen failures never offer destructive Reset. */
  allowReset?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const { t } = useLingui();
  const repair = useSave({
    save: async (action: Action, rpc) => {
      if (action === "recover")
        await computerUpdates.start(botId, "recover", (id) => rpc.computer.recover({ botId: id }));
      else await rpc.computer.reset({ botId });
      setConfirming(false);
      await onChanged();
    },
  });
  const restartScreen = useSave({
    save: async (_: undefined, rpc) => {
      await rpc.computer.restartScreen({ botId });
      await onChanged();
    },
  });
  const pending = repair.pending || restartScreen.pending;

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
  const action: Action = computer.canUpdate ? "recover" : "reset";
  const showRestart = allowRestartScreen && computer.state === "running";
  const showRepair = action === "recover" || allowReset;
  if (!showRestart && !showRepair) return null;

  return (
    <>
      {showRestart ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || pending}
          onClick={() => void restartScreen.run(undefined)}
        >
          {restartScreen.pending ? (
            <Trans>Restarting screen…</Trans>
          ) : (
            <Trans>Restart screen</Trans>
          )}
        </Button>
      ) : null}
      {showRepair ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || pending}
          onClick={() => {
            repair.reset();
            setConfirming(true);
          }}
        >
          {action === "recover" ? <Trans>Recover computer</Trans> : <Trans>Reset computer</Trans>}
        </Button>
      ) : null}
      {restartScreen.error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(restartScreen.error, t`Could not restart screen`)}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        title={
          action === "recover" ? <Trans>Recover computer?</Trans> : <Trans>Reset computer?</Trans>
        }
        description={
          action === "recover" ? (
            <Trans>Recovery restores the last saved workspace. Unsaved work may be lost.</Trans>
          ) : (
            <Trans>Restore the last saved workspace. Unsaved work on the computer is lost.</Trans>
          )
        }
        error={repair.error ? errorText(repair.error, t`Could not update computer`) : null}
        confirmDisabled={pending}
        onConfirm={() => repair.run(action)}
        confirmLabel={
          action === "recover" ? (
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
