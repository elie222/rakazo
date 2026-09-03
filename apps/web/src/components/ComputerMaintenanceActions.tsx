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
import { rpc } from "../lib/rpc";

type Action = "recover" | "reset" | "update";

export function ComputerMaintenanceActions({
  botId,
  computer,
  onChanged,
  compact = false,
  variant = "panel",
}: {
  botId: string;
  computer: ComputerStatus | null;
  onChanged: () => Promise<void>;
  compact?: boolean;
  /** `menu` hides Recover/Reset/Update behind a More control (full computer chrome). */
  variant?: "panel" | "menu";
}) {
  const { t } = useLingui();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!computer) return null;

  const busy = Boolean(computer.busyBotName) || computer.state === "booting";
  const showRecover =
    computer.state === "error" ||
    computer.state === "running" ||
    computer.state === "suspended" ||
    computer.state === "stopped";
  const showReset = showRecover;
  const showUpdate = computer.updateAvailable;
  const hasActions = showRecover || showReset || showUpdate;
  if (!hasActions) return null;

  async function run(action: Action) {
    setPending(action);
    setError(null);
    try {
      if (action === "recover") await rpc.computer.recover({ botId });
      else if (action === "reset") await rpc.computer.reset({ botId });
      else await rpc.computer.update({ botId });
      setConfirmReset(false);
      await onChanged();
      setMenuOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not update computer`);
    } finally {
      setPending(null);
    }
  }

  function openResetConfirm() {
    setError(null);
    setMenuOpen(false);
    setConfirmReset(true);
  }

  // Escape closes the dialog inside the popup, so Shell's Escape handler does not also
  // close the computer overlay.
  const resetDialog = (
    <AlertDialog
      open={confirmReset}
      onOpenChange={(open) => {
        if (!open) setConfirmReset(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Reset computer?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>Restore the last saved workspace. Unsaved work on the computer is lost.</Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction disabled={pending !== null} onClick={() => void run("reset")}>
            {pending === "reset" ? <Trans>Resetting…</Trans> : <Trans>Reset</Trans>}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (variant === "menu") {
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
            render={<Button variant="ghost" size="icon" className="text-muted-foreground" />}
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
                onClick={() => void run("recover")}
              >
                {pending === "recover" ? (
                  <Trans>Recovering…</Trans>
                ) : (
                  <Trans>Recover computer</Trans>
                )}
              </DropdownMenuItem>
            ) : null}
            {showReset ? (
              <DropdownMenuItem disabled={busy || pending !== null} onClick={openResetConfirm}>
                {pending === "reset" ? <Trans>Resetting…</Trans> : <Trans>Reset computer</Trans>}
              </DropdownMenuItem>
            ) : null}
            {showUpdate ? (
              <DropdownMenuItem
                closeOnClick={false}
                disabled={busy || pending !== null}
                onClick={() => void run("update")}
              >
                {pending === "update" ? <Trans>Updating…</Trans> : <Trans>Update computer</Trans>}
              </DropdownMenuItem>
            ) : null}
            {error ? <p className="px-1.5 py-1 text-[12.5px] text-destructive">{error}</p> : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {resetDialog}
      </>
    );
  }

  return (
    <div className={compact ? "flex flex-col items-start gap-2" : "mt-4 flex flex-col gap-3"}>
      <div className={compact ? "flex flex-wrap gap-2" : "flex flex-col gap-2"}>
        {showRecover ? (
          <Button
            variant="secondary"
            className="rounded-full"
            disabled={busy || pending !== null}
            onClick={() => void run("recover")}
          >
            {pending === "recover" ? <Trans>Recovering…</Trans> : <Trans>Recover computer</Trans>}
          </Button>
        ) : null}
        {showReset ? (
          <Button
            variant="secondary"
            className="rounded-full"
            disabled={busy || pending !== null}
            onClick={openResetConfirm}
          >
            {pending === "reset" ? <Trans>Resetting…</Trans> : <Trans>Reset computer</Trans>}
          </Button>
        ) : null}
        {showUpdate ? (
          <Button
            variant="secondary"
            className="rounded-full"
            disabled={busy || pending !== null}
            onClick={() => void run("update")}
          >
            {pending === "update" ? <Trans>Updating…</Trans> : <Trans>Update computer</Trans>}
          </Button>
        ) : null}
      </div>
      {!compact ? (
        <p className="text-[13px] leading-[1.45] text-muted-foreground/80">
          <Trans>
            Recover replaces an unreachable computer and keeps files in the saved workspace. Reset
            restores the last saved workspace and loses unsaved work. Update rebuilds with the
            latest image and keeps the saved workspace.
          </Trans>
        </p>
      ) : null}
      {error && !confirmReset ? <p className="text-[13px] text-destructive">{error}</p> : null}
      {resetDialog}
    </div>
  );
}
