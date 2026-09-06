import { Trans, useLingui } from "@lingui/react/macro";
import type { ServerUpdateCheck, ServerUpdateStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import {
  confirmUpdaterRecreate,
  isLikelyUpdaterRecreateDisconnect,
  recreateWaitTimeoutError,
} from "../lib/updater-recreate";
import { SuccessPop } from "./ai/primitives";

const RECREATE_POLL_MS = 2_000;
const RECREATE_POLL_ATTEMPTS = 90;

async function waitForUpdaterStatus(options: { beforeImageTag: string | null }): Promise<{
  status: ServerUpdateStatus;
  confirmed: boolean;
  reason: "waiting" | "running" | "unchanged" | "changed" | "failed";
}> {
  let lastError: unknown;
  let sawApi = false;
  let sawSidecar = false;
  for (let attempt = 0; attempt < RECREATE_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RECREATE_POLL_MS));
    }
    try {
      const next = await rpc.updater.status();
      sawApi = true;
      const verdict = confirmUpdaterRecreate({
        beforeImageTag: options.beforeImageTag,
        afterImageTag: next.imageTag,
        running: next.running,
        supported: next.supported,
        installKind: next.installKind,
        lastRun: next.lastRun,
      });
      if (verdict.reason === "waiting") continue;
      sawSidecar = true;
      if (verdict.reason === "running") continue;
      return { status: next, confirmed: verdict.confirmed, reason: verdict.reason };
    } catch (error) {
      lastError = error;
    }
  }
  throw recreateWaitTimeoutError({ sawApi, sawSidecar, lastError });
}

/** Presentational body for the sidecar update path (unit-testable without RPC). */
export function SoftwareUpdatePanel({
  check,
  busy,
  error,
  done,
  onCheck,
  onApply,
}: {
  check: ServerUpdateCheck | null;
  busy: "check" | "apply" | null;
  error: string | null;
  done: string | null;
  onCheck: () => void;
  onApply: () => void;
}) {
  const updateAvailable = check?.status === "available";

  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          className="rounded-full"
          disabled={busy !== null}
          onClick={onCheck}
        >
          {busy === "check" ? <Trans>Checking…</Trans> : <Trans>Check for updates</Trans>}
        </Button>
        {updateAvailable ? (
          <Button className="rounded-full" disabled={busy !== null} onClick={onApply}>
            {busy === "apply" ? <Trans>Updating…</Trans> : <Trans>Update</Trans>}
          </Button>
        ) : null}
      </div>
      {check ? <CheckSummary check={check} /> : null}
      {error ? (
        <p role="alert" className="text-[12.5px] text-destructive">
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
  const [busy, setBusy] = useState<"check" | "apply" | null>(null);
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

  // Wait for status before deciding whether to show the section (compose/source stay hidden).
  if (loading) return null;
  if (!status) {
    if (!error) return null;
    return (
      <section
        data-testid="software-update-settings"
        className="mt-5 rounded-xl border border-border bg-card px-4 py-4"
      >
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Software update</Trans>
        </h3>
        <p role="alert" className="mt-3 text-[12.5px] text-destructive">
          {error}
        </p>
      </section>
    );
  }
  if (status.installKind !== "sidecar") return null;

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

  async function finishAfterPossibleRecreate(
    action: () => Promise<{ ok: boolean; error: string | null }>,
  ) {
    // Snapshot the live tag right before apply. Panel state can be stale if another tab or
    // host update moved the image after this section last loaded.
    let beforeImageTag: string | null = null;
    try {
      const before = await rpc.updater.status();
      beforeImageTag = before.imageTag ?? null;
      setStatus(before);
      const run = await action();
      setStatus(await rpc.updater.status());
      setCheck(null);
      if (run.ok) {
        setError(null);
        setDone(t`Updated`);
      } else {
        setDone(null);
        setError(run.error ?? t`Update finished with errors`);
      }
    } catch (err) {
      if (!isLikelyUpdaterRecreateDisconnect(err)) {
        setError(err instanceof Error ? err.message : t`Update failed`);
        return;
      }
      setDone(t`Waiting for the API to come back…`);
      try {
        const recovered = await waitForUpdaterStatus({ beforeImageTag });
        setStatus(recovered.status);
        setCheck(null);
        if (recovered.confirmed) {
          setError(null);
          setDone(t`Updated`);
        } else if (recovered.reason === "failed") {
          setDone(null);
          setError(
            recovered.status.lastRun?.error ??
              recovered.status.lastRun?.restartAdvice ??
              t`Update finished with errors`,
          );
        } else {
          setDone(null);
          setError(t`API is back, but the update did not finish. Check the host logs.`);
        }
      } catch (waitError) {
        setDone(null);
        setError(
          waitError instanceof Error
            ? waitError.message
            : t`The API did not come back. Refresh this page.`,
        );
      }
    }
  }

  async function runApply() {
    setBusy("apply");
    setError(null);
    setDone(null);
    try {
      await finishAfterPossibleRecreate(() => rpc.updater.apply({}));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      data-testid="software-update-settings"
      className="mt-5 rounded-xl border border-border bg-card px-4 py-4"
    >
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Software update</Trans>
      </h3>
      <SoftwareUpdatePanel
        check={check}
        busy={busy}
        error={error}
        done={done}
        onCheck={() => void runCheck()}
        onApply={() => void runApply()}
      />
    </section>
  );
}

function CheckSummary({ check }: { check: ServerUpdateCheck }) {
  if (check.status === "up-to-date") {
    return (
      <p className="text-[12.5px] text-muted-foreground/80">
        <Trans>Up to date</Trans>
      </p>
    );
  }
  if (check.status === "available") {
    return (
      <p className="text-[12.5px] text-foreground/75">
        <Trans>Update available</Trans>
      </p>
    );
  }
  if (check.status === "dirty") {
    return (
      <p className="text-[12.5px] text-destructive">
        <Trans>Checkout has local changes. Clean it before updating.</Trans>
      </p>
    );
  }
  return (
    <p className="text-[12.5px] text-destructive">{check.reason ?? <Trans>Unavailable</Trans>}</p>
  );
}
