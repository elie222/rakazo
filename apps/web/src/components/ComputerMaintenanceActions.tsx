import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { computerUpdates } from "../lib/computer-updates";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

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
  const { t } = useLingui();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [confirmAction, setConfirmAction] = useState<"reset" | "recover" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!computer) return null;

  const busy = Boolean(computer.busyBotName) || computer.state === "booting";
  const showRecover =
    computer.state === "error" ||
    computer.state === "running" ||
    computer.state === "suspended" ||
    computer.state === "stopped";
  const showReset = showRecover;
  const showUpdate = computer.canUpdate;
  const hasActions = showRecover || showReset || showUpdate;
  if (!hasActions) return null;

  async function run(action: Action) {
    setPending(action);
    setError(null);
    try {
      if (action === "recover") await computerUpdates.start(botId, "recover");
      else if (action === "reset") await rpc.computer.reset({ botId });
      else await computerUpdates.start(botId);
      setConfirmAction(null);
      setMenuOpen(false);
      await onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not update computer`));
    } finally {
      setPending(null);
    }
  }

  function openConfirm(action: "reset" | "recover") {
    setError(null);
    setMenuOpen(false);
    setConfirmAction(action);
  }

  // Escape closes the dialog inside the popup, so Shell's Escape handler does not also
  // close the computer overlay.
  const confirmationDialog = (
    <AlertDialog
      open={confirmAction !== null}
      onOpenChange={(open) => {
        if (!open) setConfirmAction(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {confirmAction === "recover" ? (
              <Trans>Recover computer?</Trans>
            ) : (
              <Trans>Reset computer?</Trans>
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirmAction === "recover" ? (
              <Trans>Recovery restores the last saved workspace. Unsaved work may be lost.</Trans>
            ) : (
              <Trans>Restore the last saved workspace. Unsaved work on the computer is lost.</Trans>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending !== null}
            variant="destructive"
            onClick={() => {
              if (confirmAction) void run(confirmAction);
            }}
          >
            {pending === "recover" ? (
              <Trans>Recovering…</Trans>
            ) : confirmAction === "recover" ? (
              <Trans>Recover computer</Trans>
            ) : pending === "reset" ? (
              <Trans>Resetting…</Trans>
            ) : (
              <Trans>Reset</Trans>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          if (open) setError(null);
          setMenuOpen(open);
        }}
      >
        <DropdownMenuTrigger
          data-testid="computer-more-button"
          aria-label={t`More computer actions`}
          disabled={busy && pending === null}
          render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          data-testid="computer-more-menu"
          className="w-auto min-w-44"
        >
          {showRecover ? (
            <DropdownMenuItem
              closeOnClick={false}
              disabled={busy || pending !== null}
              aria-label={t`Recover computer`}
              className="flex flex-col items-start"
              onClick={() => openConfirm("recover")}
            >
              <span>
                {pending === "recover" ? (
                  <Trans>Recovering…</Trans>
                ) : (
                  <Trans>Recover computer</Trans>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                <Trans>Recreate a computer that is not working.</Trans>
              </span>
            </DropdownMenuItem>
          ) : null}
          {showReset ? (
            <DropdownMenuItem
              aria-label={t`Reset computer`}
              className="flex flex-col items-start"
              disabled={busy || pending !== null}
              onClick={() => openConfirm("reset")}
            >
              <span>
                {pending === "reset" ? <Trans>Resetting…</Trans> : <Trans>Reset computer</Trans>}
              </span>
              <span className="text-xs text-muted-foreground">
                <Trans>Restore the last saved workspace.</Trans>
              </span>
            </DropdownMenuItem>
          ) : null}
          {showUpdate ? (
            <DropdownMenuItem
              closeOnClick={false}
              disabled={busy || pending !== null}
              aria-label={t`Update computer`}
              className="flex flex-col items-start"
              onClick={() => void run("update")}
            >
              <span>
                {pending === "update" ? <Trans>Updating…</Trans> : <Trans>Update computer</Trans>}
              </span>
              <span className="text-xs text-muted-foreground">
                <Trans>Save the workspace and install current software.</Trans>
              </span>
            </DropdownMenuItem>
          ) : null}
          {error ? <p className="px-1.5 py-1 text-[12.5px] text-destructive">{error}</p> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmationDialog}
    </>
  );
}
