import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Skeleton } from "@rakazo/ui-web";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { LoadingState } from "./components/ai/primitives";
import { authClient } from "./lib/auth";
import { markAfterPaint, markOnce } from "./lib/performance";
import {
  holdUnreachableGate,
  sessionGate,
  sessionRetryDelayMs,
  showSessionUnavailable,
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
  const nextHolding = holdUnreachableGate(gate, holdingUnreachable);
  if (nextHolding !== holdingUnreachable) setHoldingUnreachable(nextHolding);

  useLayoutEffect(() => {
    if (session.isPending) return;
    markOnce("rk:renderer:session-committed");
    markAfterPaint("rk:renderer:session-painted");
  }, [session.isPending]);

  if (showSessionUnavailable(gate, nextHolding)) {
    return <SessionUnavailable refetch={session.refetch} />;
  }
  if (gate === "loading") {
    return window.location.pathname.startsWith("/app") ? (
      <ShellSkeleton />
    ) : (
      <div
        className="grid h-full place-items-center text-muted-foreground/80"
        data-rakazo-app-state="session-pending"
      >
        <Trans>Loading…</Trans>
      </div>
    );
  }

  const user = session.data?.user;
  return (
    <div className="h-full" data-rakazo-app-state="ready">
      <Suspense fallback={<div className="h-full bg-background" />}>
        <Routes>
          <Route path="/" element={user ? <Navigate to="/app" replace /> : <WelcomePage />} />
          <Route
            path="/sign-in"
            element={user ? <Navigate to="/app" replace /> : <AuthPage key="in" mode="in" />}
          />
          <Route
            path="/sign-up"
            element={user ? <Navigate to="/onboarding" replace /> : <AuthPage key="up" mode="up" />}
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
          <Route path="/app" element={user ? <ShellPage /> : <Navigate to="/sign-in" replace />} />
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
  );
}

/**
 * A session lookup that never reached the server is not a sign-out, so the app
 * waits and retries here instead of routing to sign-in and stranding a signed-in
 * user. Better Auth only polls once a session exists, so the retry lives here.
 */
function SessionUnavailable({ refetch }: { refetch: () => Promise<void> }) {
  const { t } = useLingui();
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

  return (
    <div className="grid h-full place-items-center bg-background px-6 text-center">
      <div className="flex flex-col items-center">
        <LoadingState label={t`Reconnecting`} />
        <p className="mt-3 text-[13.5px] text-muted-foreground/80">
          <Trans>Can&apos;t reach the server.</Trans>
        </p>
        <div className="mt-4">
          <Button
            variant="secondary"
            className="rounded-full"
            onClick={() => {
              retryImmediately.current = true;
              setAttempt(0);
              setRetryKey((key) => key + 1);
            }}
          >
            <Trans>Retry now</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}

function ShellSkeleton() {
  return (
    <div
      className="flex h-full overflow-hidden bg-background"
      data-rakazo-app-state="session-pending"
    >
      <aside className="hidden w-[316px] shrink-0 border-e border-sidebar-border bg-sidebar px-3.5 pt-16 md:block">
        <Skeleton className="h-10 rounded-xl" />
        <div className="mt-5 space-y-2 px-1">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-2/5" />
                <Skeleton className="h-2.5 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      </aside>
      <main className="flex flex-1 flex-col">
        <div className="h-[74px] border-b border-sidebar-border" />
        <div className="flex flex-1 items-center justify-center text-[14px] text-muted-foreground">
          <Trans>Opening your Space…</Trans>
        </div>
        <div className="mx-6 mb-6 h-[54px] rounded-full border border-border bg-background" />
      </main>
    </div>
  );
}
