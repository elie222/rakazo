import type { ServerUpdateCheck, ServerUpdateRun, ServerUpdateStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

function short(commit: string | null | undefined) {
  return commit ? commit.slice(0, 7) : "unknown";
}

function describeCheck(check: ServerUpdateCheck): string {
  if (check.status === "available") {
    // The image path has no commits to compare, only a target tag, which arrives as the reason.
    if (check.targetCommit === null) return check.reason ?? "A newer version is available.";
    const count = check.behindBy;
    const commits = `${short(check.commit)} → ${short(check.targetCommit)}`;
    const headline = count > 0 ? `${count} new commit${count === 1 ? "" : "s"}` : "A newer commit";
    return `${headline} is waiting: ${commits}.${check.reason ? ` ${check.reason}` : ""}`;
  }
  if (check.status === "up-to-date")
    return `Already on the latest commit (${short(check.commit)}).`;
  if (check.status === "dirty") {
    return `${check.reason ?? "The checkout has local changes."} ${check.changed.slice(0, 6).join(", ")}`;
  }
  return check.reason ?? "This deployment cannot be updated.";
}

/** Image deployments move a tag; checkout deployments move a commit. Say whichever actually moved. */
function describeRun(run: ServerUpdateRun, verb: string): string {
  if (!run.ok) return `${run.error ?? "The update failed."} ${run.restartAdvice}`;
  const from = run.toTag === null ? short(run.fromCommit) : (run.fromTag ?? "unknown");
  const to = run.toTag === null ? short(run.toCommit) : run.toTag;
  return `${verb} ${from} → ${to}. ${run.restartAdvice}`;
}

export function ServerUpdateOverlay({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<ServerUpdateStatus | null>(null);
  const [check, setCheck] = useState<ServerUpdateCheck | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"check" | "apply" | "source" | "rollback" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const next = await rpc.serverUpdate.status();
    setStatus(next);
    setRepoUrl(next.source.repoUrl);
    setBranch(next.source.branch);
  }

  useEffect(() => {
    void refresh()
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not load update settings"),
      )
      .finally(() => setLoading(false));
  }, []);

  async function runCheck() {
    setError(null);
    setNotice(null);
    setPending("check");
    try {
      setCheck(await rpc.serverUpdate.check());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check for updates");
    } finally {
      setPending(null);
    }
  }

  async function runApply() {
    setError(null);
    setNotice(null);
    setPending("apply");
    try {
      const run = await rpc.serverUpdate.apply();
      setNotice(describeRun(run, "Updated"));
      await refresh().catch(() => undefined);
      setCheck(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply the update");
    } finally {
      setPending(null);
    }
  }

  async function runRollback() {
    setError(null);
    setNotice(null);
    setPending("rollback");
    try {
      const run = await rpc.serverUpdate.rollback();
      setNotice(describeRun(run, "Rolled back"));
      await refresh().catch(() => undefined);
      setCheck(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not roll back");
    } finally {
      setPending(null);
    }
  }

  async function saveSource() {
    setError(null);
    setNotice(null);
    setPending("source");
    try {
      const next = await rpc.serverUpdate.setSource({ repoUrl, branch });
      setStatus(next);
      setCheck(null);
      setNotice(
        next.source.official
          ? "Now tracking the official Rakazo repository."
          : `Now tracking ${next.source.repoUrl} on ${next.source.branch}. The server will run whatever code that repository contains.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that repository");
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;
  const lastRun = status?.lastRun ?? null;

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(4,4,5,.62)] p-4 sm:p-10">
      <div className="flex h-[min(760px,100%)] w-[760px] max-w-full flex-col overflow-hidden rounded-[26px] border border-[#232326] bg-[#141416] shadow-[0_40px_90px_rgba(0,0,0,.55)]">
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <div className="text-2xl font-medium text-[#F1F1F2]">Server updates</div>
            <p className="mt-1 text-[13.5px] text-[#7A7A80]">
              {loading
                ? "Loading deployment state…"
                : "Pull the latest Rakazo code onto this server and apply it."}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close server updates"
            onClick={onClose}
            className="text-[#85858A]"
          >
            ✕
          </button>
        </div>

        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          {error ? <p className="mb-4 text-sm text-[#C94244]">{error}</p> : null}
          {notice ? <p className="mb-4 text-sm text-[#4ECB71]">{notice}</p> : null}

          {status ? (
            <>
              <div className="rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-3">
                <div className="text-[12.5px] uppercase tracking-[0.08em] text-[#6C6C70]">
                  Running now
                </div>
                <div className="mt-1 text-[16px] text-[#F1F1F2]">
                  {status.version} · {short(status.revision)}
                  {status.imageTag ? ` · ${status.imageTag}` : ""}
                </div>
                <div className="mt-1 text-[13px] text-[#85858A]">
                  {status.supported
                    ? `${status.source.official ? "Official repository" : status.source.repoUrl} on ${status.branch ?? status.source.branch}`
                    : (status.unsupportedReason ?? "Self-update is unavailable.")}
                </div>
              </div>

              {status.supported ? (
                <>
                  {status.dirty ? (
                    <p className="mt-4 text-[13px] leading-[1.5] text-[#C94244]">
                      The deployment checkout has uncommitted changes to tracked files (
                      {status.dirtyPaths.slice(0, 4).join(", ")}
                      {status.dirtyPaths.length > 4 ? ", …" : ""}). Commit, stash, or discard them
                      before updating.
                    </p>
                  ) : null}

                  {status.strategy === "build" && status.strategyNote ? (
                    <p className="mt-4 text-[13px] leading-[1.5] text-[#E65707]">
                      {status.strategyNote}
                    </p>
                  ) : null}

                  <p className="mt-4 text-[13px] leading-[1.5] text-[#85858A]">
                    {status.restartAdvice}
                  </p>

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void runCheck()}
                    >
                      {pending === "check" ? "Checking…" : "Check for updates"}
                    </Button>
                    <Button
                      type="button"
                      variant="pill"
                      size="sm"
                      disabled={busy || status.dirty || check?.status !== "available"}
                      onClick={() => void runApply()}
                    >
                      {pending === "apply"
                        ? status.strategy === "build"
                          ? "Building…"
                          : "Updating…"
                        : "Update this server"}
                    </Button>
                    {status.canRollback ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void runRollback()}
                      >
                        {pending === "rollback"
                          ? "Rolling back…"
                          : `Roll back to ${status.previousImageTag}`}
                      </Button>
                    ) : null}
                  </div>

                  {status.canRollback ? (
                    <p className="mt-3 text-[12.5px] leading-[1.5] text-[#6C6C70]">
                      Rolling back redeploys the previous image. Database migrations are not
                      reversed, so if the newer version added one, roll forward again or restore a
                      database backup.
                    </p>
                  ) : null}

                  {check ? (
                    <p
                      className={`mt-3 text-[13px] leading-[1.5] ${
                        check.status === "available" ? "text-[#ECECEE]" : "text-[#85858A]"
                      }`}
                    >
                      {describeCheck(check)}
                    </p>
                  ) : null}

                  <details className="mt-6 rounded-[13px] border border-[#26262A] px-4 py-3">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[13.5px] text-[#ECECEE] [&::-webkit-details-marker]:hidden">
                      <span className="font-medium">Advanced</span>
                      <span className="text-[12px] text-[#6C6C70]">
                        {status.source.official ? "Official repository" : "Custom repository"}
                      </span>
                    </summary>
                    <p className="mt-3 text-[13px] leading-[1.5] text-[#E65707]">
                      Whatever repository you point this at becomes the code this server runs. Only
                      use a repository you control and trust — a fork you own, not one you found.
                    </p>
                    <label className="mt-4 block text-[13.5px] text-[#85858A]">
                      Repository URL
                      <input
                        value={repoUrl}
                        onChange={(event) => setRepoUrl(event.target.value)}
                        placeholder={status.officialRepoUrl}
                        autoComplete="off"
                        spellCheck={false}
                        className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none focus:border-[#4A4A50]"
                      />
                    </label>
                    <label className="mt-3 block text-[13.5px] text-[#85858A]">
                      Branch
                      <input
                        value={branch}
                        onChange={(event) => setBranch(event.target.value)}
                        placeholder="main"
                        autoComplete="off"
                        spellCheck={false}
                        className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none focus:border-[#4A4A50]"
                      />
                    </label>
                    <p className="mt-3 text-[12.5px] leading-[1.5] text-[#6C6C70]">
                      https:// and ssh:// git remotes only. The official repository publishes
                      images, so updating it is a download and a restart. A fork has no published
                      images, so the server builds it here — minutes rather than seconds. Updates
                      always fast-forward; they never discard commits that only exist on this
                      server.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || !repoUrl.trim() || !branch.trim()}
                        onClick={() => void saveSource()}
                      >
                        {pending === "source" ? "Saving…" : "Save source"}
                      </Button>
                      {status.source.official ? null : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setRepoUrl(status.officialRepoUrl);
                            setBranch("main");
                          }}
                        >
                          Use the official repository
                        </Button>
                      )}
                    </div>
                  </details>
                </>
              ) : null}

              {lastRun ? (
                <div className="mt-6 rounded-[13px] border border-[#26262A] px-4 py-3">
                  <div className="text-[12.5px] uppercase tracking-[0.08em] text-[#6C6C70]">
                    Last update
                  </div>
                  <div className="mt-1 text-[14px] text-[#ECECEE]">
                    {lastRun.ok ? "Succeeded" : "Failed"} ·{" "}
                    {lastRun.toTag === null
                      ? `${short(lastRun.fromCommit)} → ${short(lastRun.toCommit)}`
                      : `${lastRun.fromTag ?? "unknown"} → ${lastRun.toTag}`}{" "}
                    · {new Date(lastRun.startedAt).toLocaleString()}
                  </div>
                  <div className="mt-1 text-[13px] text-[#85858A]">{lastRun.restartAdvice}</div>
                  {lastRun.steps.length ? (
                    <ul className="mt-3 space-y-2">
                      {lastRun.steps.map((step) => (
                        <li key={step.id} className="rounded-[10px] bg-[#101012] px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[13.5px] text-[#ECECEE]">
                              {step.label}
                            </span>
                            <span
                              className={`text-[12px] ${step.ok ? "text-[#4ECB71]" : "text-[#C94244]"}`}
                            >
                              {step.ok ? "ok" : `exit ${step.exitCode ?? "?"}`}
                            </span>
                          </div>
                          {step.ok ? null : (
                            <pre className="rk-scroll mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-[1.45] text-[#85858A]">
                              {step.output}
                            </pre>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : loading ? (
            <p className="text-[#85858A]">Loading deployment state…</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
