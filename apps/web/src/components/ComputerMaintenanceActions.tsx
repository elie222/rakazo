import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { BuiButton, BuiCard } from "./beautiful-ui/primitives";

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
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Keep Escape active while the reset dialog is open even after the menu closes,
    // so Escape dismisses confirm instead of Shell closing the computer overlay.
    if (!menuOpen && !confirmReset) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // Stop bubbling so Shell's Escape handler does not also close the computer.
      event.stopPropagation();
      if (confirmReset) {
        setConfirmReset(false);
        return;
      }
      setMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, confirmReset]);

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

  const resetDialog = confirmReset ? (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[rgba(4,4,5,.72)] px-6"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="reset-computer-title"
      aria-describedby="reset-computer-description"
    >
      <BuiCard className="w-full max-w-[420px] border border-[var(--rk-hairline-strong)] p-5">
        <div id="reset-computer-title" className="text-[16px] font-medium text-[var(--rk-ink)]">
          <Trans>Reset computer?</Trans>
        </div>
        <p
          id="reset-computer-description"
          className="mt-2 text-[14px] leading-[1.5] text-[var(--rk-muted)]"
        >
          <Trans>Restore the last saved workspace. Unsaved work on the computer is lost.</Trans>
        </p>
        {error ? <p className="mt-2 text-[13px] text-[var(--rk-danger)]">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <BuiButton onClick={() => setConfirmReset(false)}>
            <Trans>Cancel</Trans>
          </BuiButton>
          <BuiButton tone="accent" disabled={pending !== null} onClick={() => void run("reset")}>
            {pending === "reset" ? <Trans>Resetting…</Trans> : <Trans>Reset</Trans>}
          </BuiButton>
        </div>
      </BuiCard>
    </div>
  ) : null;

  if (variant === "menu") {
    return (
      <div ref={rootRef} className="relative">
        <button
          type="button"
          id={menuId}
          data-testid="computer-more-button"
          aria-label={t`More computer actions`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={busy && pending === null}
          onClick={() => {
            setError(null);
            setMenuOpen((open) => !open);
          }}
          className="grid h-8 w-8 place-items-center rounded-[10px] text-[var(--rk-muted)] hover:bg-[var(--rk-elevated)] hover:text-[var(--rk-ink)] disabled:opacity-40"
        >
          <MoreHorizontal size={16} strokeWidth={1.8} />
        </button>
        {menuOpen ? (
          <div
            role="menu"
            aria-labelledby={menuId}
            data-testid="computer-more-menu"
            className="absolute end-0 top-full z-20 mt-1.5 min-w-[180px] rounded-[12px] border border-[var(--rk-scroll)] bg-[var(--rk-surface)] py-1.5 shadow-[0_12px_40px_rgba(0,0,0,.55)]"
          >
            {showRecover ? (
              <button
                type="button"
                role="menuitem"
                disabled={busy || pending !== null}
                onClick={() => void run("recover")}
                className="flex w-full px-3.5 py-2.5 text-start text-[14px] text-[var(--rk-ink)] hover:bg-[var(--rk-elevated)] disabled:opacity-40"
              >
                {pending === "recover" ? (
                  <Trans>Recovering…</Trans>
                ) : (
                  <Trans>Recover computer</Trans>
                )}
              </button>
            ) : null}
            {showReset ? (
              <button
                type="button"
                role="menuitem"
                disabled={busy || pending !== null}
                onClick={() => {
                  setError(null);
                  setMenuOpen(false);
                  setConfirmReset(true);
                }}
                className="flex w-full px-3.5 py-2.5 text-start text-[14px] text-[var(--rk-ink)] hover:bg-[var(--rk-elevated)] disabled:opacity-40"
              >
                {pending === "reset" ? <Trans>Resetting…</Trans> : <Trans>Reset computer</Trans>}
              </button>
            ) : null}
            {showUpdate ? (
              <button
                type="button"
                role="menuitem"
                disabled={busy || pending !== null}
                onClick={() => void run("update")}
                className="flex w-full px-3.5 py-2.5 text-start text-[14px] text-[var(--rk-ink)] hover:bg-[var(--rk-elevated)] disabled:opacity-40"
              >
                {pending === "update" ? <Trans>Updating…</Trans> : <Trans>Update computer</Trans>}
              </button>
            ) : null}
            {error ? (
              <p className="px-3.5 py-2 text-[12.5px] text-[var(--rk-danger)]">{error}</p>
            ) : null}
          </div>
        ) : null}
        {resetDialog}
      </div>
    );
  }

  return (
    <div className={compact ? "flex flex-col items-start gap-2" : "mt-4 flex flex-col gap-3"}>
      <div className={compact ? "flex flex-wrap gap-2" : "flex flex-col gap-2"}>
        {showRecover ? (
          <BuiButton disabled={busy || pending !== null} onClick={() => void run("recover")}>
            {pending === "recover" ? <Trans>Recovering…</Trans> : <Trans>Recover computer</Trans>}
          </BuiButton>
        ) : null}
        {showReset ? (
          <BuiButton
            disabled={busy || pending !== null}
            onClick={() => {
              setError(null);
              setConfirmReset(true);
            }}
          >
            {pending === "reset" ? <Trans>Resetting…</Trans> : <Trans>Reset computer</Trans>}
          </BuiButton>
        ) : null}
        {showUpdate ? (
          <BuiButton disabled={busy || pending !== null} onClick={() => void run("update")}>
            {pending === "update" ? <Trans>Updating…</Trans> : <Trans>Update computer</Trans>}
          </BuiButton>
        ) : null}
      </div>
      {!compact ? (
        <p className="text-[13px] leading-[1.45] text-[var(--rk-muted-2)]">
          <Trans>
            Recover replaces an unreachable computer and keeps files in the saved workspace. Reset
            restores the last saved workspace and loses unsaved work. Update rebuilds with the
            latest image and keeps the saved workspace.
          </Trans>
        </p>
      ) : null}
      {error && !confirmReset ? (
        <p className="text-[13px] text-[var(--rk-danger)]">{error}</p>
      ) : null}
      {resetDialog}
    </div>
  );
}
