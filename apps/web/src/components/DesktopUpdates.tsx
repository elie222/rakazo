import { Trans, useLingui } from "@lingui/react/macro";
import type { DesktopUpdateState } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { desktopBridge } from "../lib/desktop";

function useDesktopUpdates() {
  const { t } = useLingui();
  const bridge = desktopBridge()?.update;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmedCheck, setConfirmedCheck] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    if (!bridge) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const started = revision.current;
      try {
        const next = await bridge!.state();
        if (!stopped && started === revision.current && !pending.current) {
          setState((current) =>
            current &&
            Object.entries(next).every(
              ([key, value]) => current[key as keyof DesktopUpdateState] === value,
            )
              ? current
              : next,
          );
        }
      } catch {
        // A disappearing bridge during shutdown should not interrupt the app.
      } finally {
        if (!stopped) timer = setTimeout(refresh, 2_000);
      }
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge]);

  async function act(action: "check" | "install") {
    if (!bridge || pending.current) return;
    pending.current = true;
    revision.current++;
    setBusy(true);
    setError(null);
    if (action === "check") setConfirmedCheck(null);
    try {
      const next = await bridge[action]();
      setState(next);
      if (
        action === "check" &&
        next.phase === "idle" &&
        !next.message &&
        next.checkedAt !== state?.checkedAt
      ) {
        setConfirmedCheck(next.checkedAt);
      }
      if (next.phase === "error" || action === "install") {
        setError(next.message);
      }
    } catch {
      setError(t`Could not complete the update. Try again.`);
    } finally {
      revision.current++;
      pending.current = false;
      setBusy(false);
    }
  }
  return { state, busy, error, act, confirmedCheck };
}

const UpdatesContext = createContext<ReturnType<typeof useDesktopUpdates> | null>(null);

export function DesktopUpdatesProvider({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const updates = useDesktopUpdates();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { state, busy, error, act } = updates;
  return (
    <UpdatesContext.Provider value={updates}>
      {children}
      {state &&
      (state.phase === "ready" || (error && state.availableVersion)) &&
      dismissed !== state.availableVersion ? (
        <aside
          aria-label={t`Desktop update`}
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-3 text-card-foreground shadow-lg"
        >
          <div className="flex items-center gap-2">
            <Button
              disabled={busy}
              onClick={() => void act(state.phase === "ready" ? "install" : "check")}
            >
              {state.phase === "ready" ? (
                <Trans>Restart to update</Trans>
              ) : (
                <Trans>Check for updates</Trans>
              )}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setDismissed(state.availableVersion)}
            >
              <Trans>Later</Trans>
            </Button>
          </div>
          {error || state.message ? (
            <p role="status" className="mt-2 text-sm">
              {error ?? state.message}
            </p>
          ) : null}
        </aside>
      ) : null}
    </UpdatesContext.Provider>
  );
}

export function DesktopUpdateSection() {
  const updates = useContext(UpdatesContext);
  if (!updates?.state) return null;
  const { state, busy, error, act, confirmedCheck } = updates;
  const ready = state.phase === "ready";
  const downloading = state.phase === "available" || state.phase === "downloading";
  return (
    <section
      data-testid="desktop-update-settings"
      className="mt-5 rounded-xl border border-border px-4 py-4"
    >
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Desktop app</Trans>
      </h3>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">v{state.currentVersion}</span>
        <Button
          variant="outline"
          disabled={busy || downloading || state.phase === "checking"}
          onClick={() => void act(ready ? "install" : "check")}
        >
          {ready ? (
            <Trans>Restart to update</Trans>
          ) : downloading ? (
            <Trans>Downloading…</Trans>
          ) : busy || state.phase === "checking" ? (
            <Trans>Checking…</Trans>
          ) : (
            <Trans>Check for updates</Trans>
          )}
        </Button>
      </div>
      <p role="status" className="mt-2 text-sm text-muted-foreground">
        {error ??
          state.message ??
          (downloading ? (
            `${state.percent ?? 0}%`
          ) : state.phase === "idle" && confirmedCheck && state.checkedAt === confirmedCheck ? (
            <Trans>Up to date</Trans>
          ) : null)}
      </p>
    </section>
  );
}
