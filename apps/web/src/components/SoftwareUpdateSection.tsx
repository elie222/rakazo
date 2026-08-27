import { Trans, useLingui } from "@lingui/react/macro";
import type { ServerUpdateCheck, ServerUpdateStatus } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { BuiButton, LoadingState, SuccessPop } from "./beautiful-ui/primitives";

function shortRev(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 12 ? value.slice(0, 12) : value;
}

/** Presentational body so unit tests can render install-kind branches without RPC. */
export function SoftwareUpdatePanel({
  status,
  check,
  busy,
  error,
  done,
  onCheck,
  onApply,
  onRollback,
}: {
  status: ServerUpdateStatus;
  check: ServerUpdateCheck | null;
  busy: "check" | "apply" | "rollback" | null;
  error: string | null;
  done: string | null;
  onCheck: () => void;
  onApply: () => void;
  onRollback: () => void;
}) {
  return (
    <div className="mt-3 space-y-3">
      <p className="text-[13.5px] text-[#C9C9CE]">
        {status.imageTag ? (
          <Trans>Image {status.imageTag}</Trans>
        ) : status.revision ? (
          <Trans>Revision {shortRev(status.revision)}</Trans>
        ) : (
          <Trans>Version {status.version}</Trans>
        )}
      </p>

      {status.installKind === "sidecar" ? (
        <>
          <p className="text-[12.5px] text-[#6C6C70]">
            <Trans>Updates pull the published image through the updater sidecar.</Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            <BuiButton disabled={busy !== null} onClick={onCheck}>
              {busy === "check" ? <Trans>Checking…</Trans> : <Trans>Check</Trans>}
            </BuiButton>
            <BuiButton
              tone="accent"
              disabled={busy !== null || check?.status === "dirty"}
              onClick={onApply}
            >
              {busy === "apply" ? <Trans>Updating…</Trans> : <Trans>Update</Trans>}
            </BuiButton>
            {status.canRollback ? (
              <BuiButton disabled={busy !== null} onClick={onRollback}>
                {busy === "rollback" ? <Trans>Rolling back…</Trans> : <Trans>Rollback</Trans>}
              </BuiButton>
            ) : null}
          </div>
          {check ? <CheckSummary check={check} /> : null}
        </>
      ) : null}

      {status.installKind === "compose" ? (
        <>
          <p className="text-[12.5px] text-[#6C6C70]">
            <Trans>Compose install without the updater sidecar. Run these on the host.</Trans>
          </p>
          <CommandBlock commands={status.manualCommands} />
        </>
      ) : null}

      {status.installKind === "source" ? (
        <>
          <p className="text-[12.5px] text-[#6C6C70]">
            <Trans>Source install. Upgrade from a terminal.</Trans>
          </p>
          <CommandBlock commands={status.manualCommands} />
        </>
      ) : null}

      {status.unsupportedReason && status.installKind === "sidecar" ? (
        <p className="text-[12.5px] text-[#F1A8A8]">{status.unsupportedReason}</p>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12.5px] text-[#F1A8A8]">
          {error}
        </p>
      ) : null}
      {done ? <SuccessPop label={done} /> : null}
    </div>
  );
}

export function SoftwareUpdateSection({ isDeploymentOwner }: { isDeploymentOwner: boolean }) {
  const { t } = useLingui();
  const [status, setStatus] = useState<ServerUpdateStatus | null>(null);
  const [check, setCheck] = useState<ServerUpdateCheck | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"check" | "apply" | "rollback" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!isDeploymentOwner) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void rpc.updater
      .status()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t`Could not load update status`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isDeploymentOwner, t]);

  if (!isDeploymentOwner) return null;

  async function runCheck() {
    setBusy("check");
    setError(null);
    setDone(null);
    try {
      setCheck(await rpc.updater.check({}));
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Check failed`);
    } finally {
      setBusy(null);
    }
  }

  async function runApply() {
    setBusy("apply");
    setError(null);
    setDone(null);
    try {
      const run = await rpc.updater.apply({});
      setStatus(await rpc.updater.status());
      setCheck(null);
      setDone(run.ok ? t`Updated` : (run.error ?? t`Update finished with errors`));
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Update failed`);
    } finally {
      setBusy(null);
    }
  }

  async function runRollback() {
    setBusy("rollback");
    setError(null);
    setDone(null);
    try {
      const run = await rpc.updater.rollback();
      setStatus(await rpc.updater.status());
      setCheck(null);
      setDone(run.ok ? t`Rolled back` : (run.error ?? t`Rollback finished with errors`));
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Rollback failed`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      data-testid="software-update-settings"
      className="mt-5 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-4"
    >
      <h3 className="text-[15px] font-medium text-[#ECECEE]">
        <Trans>Software update</Trans>
      </h3>

      {loading ? (
        <div className="mt-3">
          <LoadingState label={t`Loading`} />
        </div>
      ) : null}

      {!loading && status ? (
        <SoftwareUpdatePanel
          status={status}
          check={check}
          busy={busy}
          error={error}
          done={done}
          onCheck={() => void runCheck()}
          onApply={() => void runApply()}
          onRollback={() => void runRollback()}
        />
      ) : null}

      {!loading && !status && error ? (
        <p role="alert" className="mt-3 text-[12.5px] text-[#F1A8A8]">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function CheckSummary({ check }: { check: ServerUpdateCheck }) {
  if (check.status === "up-to-date") {
    return (
      <p className="text-[12.5px] text-[#6C6C70]">
        <Trans>Up to date</Trans>
        {check.targetTag ? ` (${check.targetTag})` : null}
      </p>
    );
  }
  if (check.status === "available") {
    return (
      <p className="text-[12.5px] text-[#C9C9CE]">
        <Trans>Update available</Trans>
        {check.targetTag ? `: ${check.targetTag}` : null}
        {check.targetCommit && !check.targetTag ? `: ${shortRev(check.targetCommit)}` : null}
      </p>
    );
  }
  if (check.status === "dirty") {
    return (
      <p className="text-[12.5px] text-[#F1A8A8]">
        <Trans>Checkout has local changes. Clean it before updating.</Trans>
      </p>
    );
  }
  return (
    <p className="text-[12.5px] text-[#F1A8A8]">{check.reason ?? <Trans>Unavailable</Trans>}</p>
  );
}

function CommandBlock({ commands }: { commands: string[] }) {
  if (commands.length === 0) return null;
  return (
    <pre
      data-testid="software-update-commands"
      className="overflow-x-auto rounded-[10px] border border-[#232326] bg-[#0C0C0E] px-3 py-2.5 font-mono text-[11.5px] leading-5 text-[#C9C9CE]"
    >
      {commands.join("\n")}
    </pre>
  );
}
