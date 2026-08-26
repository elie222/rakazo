import type { ComputerStatus } from "@rakazo/contracts";
import { useState } from "react";
import { rpc } from "../lib/rpc";

type Action = "recover" | "reset" | "update";

export function ComputerMaintenanceActions({
  botId,
  computer,
  onChanged,
  compact = false,
}: {
  botId: string;
  computer: ComputerStatus | null;
  onChanged: () => Promise<void>;
  compact?: boolean;
}) {
  const [pending, setPending] = useState<Action | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!computer || computer.kind === "desktop") return null;

  const busy = Boolean(computer.busyBotName) || computer.state === "booting";
  const showRecover =
    computer.state === "error" ||
    computer.state === "running" ||
    computer.state === "suspended" ||
    computer.state === "stopped";
  const showReset = showRecover;
  const showUpdate = computer.updateAvailable;

  async function run(action: Action) {
    setPending(action);
    setError(null);
    try {
      if (action === "recover") await rpc.computer.recover({ botId });
      else if (action === "reset") await rpc.computer.reset({ botId });
      else await rpc.computer.update({ botId });
      setConfirmReset(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update computer");
    } finally {
      setPending(null);
    }
  }

  const buttonClass = compact
    ? "text-[13px] text-[#85858A] hover:text-[#ECECEE] disabled:opacity-40"
    : "rounded-[11px] border border-[#26262A] px-3.5 py-2 text-[14px] text-[#ECECEE] disabled:opacity-40";

  return (
    <div className={compact ? "flex flex-col items-start gap-2" : "mt-4 flex flex-col gap-3"}>
      <div className={compact ? "flex flex-wrap gap-3" : "flex flex-col gap-2"}>
        {showRecover ? (
          <button
            type="button"
            disabled={busy || pending !== null}
            className={buttonClass}
            onClick={() => void run("recover")}
          >
            {pending === "recover" ? "Recovering…" : "Recover computer"}
          </button>
        ) : null}
        {showReset ? (
          <button
            type="button"
            disabled={busy || pending !== null}
            className={buttonClass}
            onClick={() => setConfirmReset(true)}
          >
            {pending === "reset" ? "Resetting…" : "Reset computer"}
          </button>
        ) : null}
        {showUpdate ? (
          <button
            type="button"
            disabled={busy || pending !== null}
            className={buttonClass}
            onClick={() => void run("update")}
          >
            {pending === "update" ? "Updating…" : "Update computer"}
          </button>
        ) : null}
      </div>
      {!compact ? (
        <p className="text-[13px] leading-[1.45] text-[#6C6C70]">
          Recover replaces an unreachable computer and keeps files in the saved workspace. Reset
          restores the last saved workspace and loses unsaved work. Update rebuilds with the latest
          image and keeps the saved workspace.
        </p>
      ) : null}
      {error ? <p className="text-[13px] text-[#E65707]">{error}</p> : null}
      {confirmReset ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-[rgba(4,4,5,.72)] px-6"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-[420px] rounded-[14px] border border-[#232326] bg-[#0E0E10] p-5">
            <div className="text-[16px] font-medium text-[#ECECEE]">Reset computer?</div>
            <p className="mt-2 text-[14px] leading-[1.5] text-[#85858A]">
              Restore the last saved workspace. Unsaved work on the computer is lost.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-[11px] border border-[#26262A] px-4 py-2 text-[14px] text-[#ECECEE]"
                onClick={() => setConfirmReset(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-[11px] bg-[#E65707] px-4 py-2 text-[14px] text-[#17171A]"
                onClick={() => void run("reset")}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
