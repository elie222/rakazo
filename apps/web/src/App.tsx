import { Trans, useLingui } from "@lingui/react/macro";
import { connectionHintForOrigin, describeConnectionOrigin } from "@rakazo/core";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { BuiButton, LoadingState } from "./components/beautiful-ui/primitives";
import { authClient } from "./lib/auth";
import { markAfterPaint, markOnce } from "./lib/performance";
import {
  holdUnreachableGate,
  sessionGate,
  sessionReconnectKind,
  sessionRetryDelayMs,
  workspaceMounted,
} from "./lib/session-gate";
import { McpOAuthCallbackPage } from "./pages/McpOAuthCallback";
import { ShellPage } from "./pages/Shell";

const AuthPage = lazy(() =>
  import("./pages/Auth").then((module) => ({ default: module.AuthPage })),
);
const PasswordResetPage = lazy(() =>
  import("./pages/Auth").then((module) => ({ default: module.PasswordResetPage })),
);
const OnboardingPage = lazy(() =>
  import("./pages/Onboarding").then((module) => ({ default: module.OnboardingPage })),
);
const WelcomePage = lazy(() =>
  import("./pages/Welcome").then((module) => ({ default: module.WelcomePage })),
);

export function App() {
  const session = authClient.useSession();
  const gate = sessionGate(session);
  const [holdingUnreachable, setHoldingUnreachable] = useState(false);
  const [sawWorkspace, setSawWorkspace] = useState(false);
  const nextHolding = holdUnreachableGate(gate, holdingUnreachable);
  if (nextHolding !== holdingUnreachable) setHoldingUnreachable(nextHolding);
  const nextMounted = workspaceMounted(gate, sawWorkspace, nextHolding);
  if (nextMounted !== sawWorkspace) setSawWorkspace(nextMounted);
  const reconnect = sessionReconnectKind(session, nextHolding, nextMounted);
  const lastUser = useRef<unknown>(null);
  if (session.data?.user) lastUser.current = session.data.user;
  else if (!nextMounted) lastUser.current = null;

  useLayoutEffect(() => {
    if (session.isPending) return;
    markOnce("rk:renderer:session-committed");
    markAfterPaint("rk:renderer:session-painted");
  }, [session.isPending]);

  if (reconnect === "blocking") {
    return <SessionUnavailable refetch={session.refetch} />;
  }
  if (gate === "loading" && reconnect === "none") {
    return window.location.pathname.startsWith("/app") ? (
      <ShellSkeleton />
    ) : (
      <div
        className="grid h-full place-items-center text-[#6C6C70]"
        data-rakazo-app-state="session-pending"
      >
        <Trans>Loading…</Trans>
      </div>
    );
  }

  const user = session.data?.user ?? (reconnect === "banner" ? lastUser.current : null);
  return (
    <div className="flex h-full flex-col" data-rakazo-app-state="ready">
      {reconnect === "banner" ? <SessionReconnectBar refetch={session.refetch} /> : null}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="h-full bg-[#050506]" />}>
          <Routes>
            <Route path="/" element={user ? <Navigate to="/app" replace /> : <WelcomePage />} />
            <Route
              path="/sign-in"
              element={user ? <Navigate to="/app" replace /> : <AuthPage key="in" mode="in" />}
            />
            <Route
              path="/sign-up"
              element={
                user ? <Navigate to="/onboarding" replace /> : <AuthPage key="up" mode="up" />
              }
            />
            <Route
              path="/forgot-password"
              element={
                user ? <Navigate to="/app" replace /> : <AuthPage key="forgot" mode="forgot" />
              }
            />
            <Route path="/reset-password" element={<PasswordResetPage />} />
            <Route
              path="/onboarding"
              element={user ? <OnboardingPage /> : <Navigate to="/sign-in" replace />}
            />
            <Route
              path="/mcp/oauth/callback"
              element={user ? <McpOAuthCallbackPage /> : <Navigate to="/sign-in" replace />}
            />
            <Route
              path="/app"
              element={user ? <ShellPage /> : <Navigate to="/sign-in" replace />}
            />
            <Route
              path="/app/g/:groupId"
              element={user ? <ShellPage /> : <Navigate to="/sign-in" replace />}
            />
            <Route
              path="/app/:botId"
              element={user ? <ShellPage /> : <Navigate to="/sign-in" replace />}
            />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}

/**
 * A session lookup that never reached the server is not a sign-out, so the app
 * waits and retries here instead of routing to sign-in and stranding a signed-in
 * user. Better Auth only polls once a session exists, so the retry lives here.
 */
function useSessionRetry(refetch: () => Promise<void>) {
  const [attempt, setAttempt] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const retryImmediately = useRef(false);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    let cancelled = false;
    const delay = retryImmediately.current ? 0 : sessionRetryDelayMs(attempt);
    retryImmediately.current = false;
    const timer = setTimeout(() => {
      void refetchRef.current().finally(() => {
        if (!cancelled) setAttempt((value) => value + 1);
      });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attempt, retryKey]);

  return () => {
    retryImmediately.current = true;
    setAttempt(0);
    setRetryKey((key) => key + 1);
  };
}

function SessionUnavailable({ refetch }: { refetch: () => Promise<void> }) {
  const { t } = useLingui();
  const retryNow = useSessionRetry(refetch);
  const origin = describeConnectionOrigin(window.location.origin);
  const hint = connectionHintForOrigin(window.location.origin);

  return (
    <div
      className="grid h-full place-items-center bg-[#050506] px-6 text-center"
      data-rakazo-reconnect="blocking"
    >
      <div className="flex flex-col items-center">
        <LoadingState label={t`Reconnecting`} />
        <p className="mt-3 text-[13.5px] text-[#6C6C70]">
          <Trans>Can&apos;t reach the server.</Trans>
        </p>
        {origin ? <p className="mt-1 font-mono text-[12px] text-[#6C6C70]">{origin}</p> : null}
        {hint ? <p className="mt-1 text-[12px] text-[#85858A]">{hint}</p> : null}
        <div className="mt-4">
          <BuiButton onClick={retryNow}>
            <Trans>Retry now</Trans>
          </BuiButton>
        </div>
      </div>
    </div>
  );
}

function SessionReconnectBar({ refetch }: { refetch: () => Promise<void> }) {
  const retryNow = useSessionRetry(refetch);
  const origin = describeConnectionOrigin(window.location.origin);
  const hint = connectionHintForOrigin(window.location.origin);

  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-[#26262A] bg-[#121214] px-4 py-2"
      data-rakazo-reconnect="banner"
      role="status"
    >
      <p className="text-[13px] text-[#9A9AA0]">
        <Trans>Can&apos;t reach the server.</Trans>
      </p>
      {origin ? <p className="font-mono text-[12px] text-[#6C6C70]">{origin}</p> : null}
      {hint ? <p className="text-[12px] text-[#85858A]">{hint}</p> : null}
      <BuiButton onClick={retryNow}>
        <Trans>Retry now</Trans>
      </BuiButton>
    </div>
  );
}

function ShellSkeleton() {
  return (
    <div
      className="flex h-full overflow-hidden bg-[#050506]"
      data-rakazo-app-state="session-pending"
    >
      <aside className="hidden w-[316px] shrink-0 border-e border-[#171719] bg-[#0B0B0C] px-3.5 pt-16 md:block">
        <div className="h-10 rounded-xl bg-[#141416]" />
        <div className="mt-5 space-y-2 px-1">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
              <div className="h-9 w-9 rounded-full bg-[#18181B]" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-2/5 rounded bg-[#202024]" />
                <div className="h-2.5 w-4/5 rounded bg-[#151518]" />
              </div>
            </div>
          ))}
        </div>
      </aside>
      <main className="flex flex-1 flex-col">
        <div className="h-[74px] border-b border-[#141416]" />
        <div className="flex flex-1 items-center justify-center text-[14px] text-[#55555A]">
          <Trans>Opening your Space…</Trans>
        </div>
        <div className="mx-6 mb-6 h-[54px] rounded-full border border-[#202023] bg-[#131315]" />
      </main>
    </div>
  );
}
