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
 * The one repair a broken computer offers: rebuild its system where the computer can be updated
 * in place, and otherwise restore its last saved workspace. Shown only beside a failure.
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
  const action: Action = computer.canUpdate ? "recover" : "reset";

  return (
    <>
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
