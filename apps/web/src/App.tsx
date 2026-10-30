import { Trans, useLingui } from "@lingui/react/macro";
import type { LinkFavicons } from "@rakazo/chat-ui/web";
import { LinkFaviconsContext, RemoteImagesContext } from "@rakazo/chat-ui/web";
import { analyticsScreen } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { LoadingState } from "./components/ai/primitives";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { MarkdownLinkPrompt } from "./components/markdown-link-prompt";
import { PageLoading } from "./components/PageLoading";
import { SubscriptionGate } from "./components/SubscriptionGate";
import { authClient } from "./lib/auth";
import { getTicketBoardEnabled, subscribeTicketBoardEnabled } from "./lib/bootstrap";
import { syncCallIdentity } from "./lib/call-session";
import { desktopBridge } from "./lib/desktop";
import { syncWebLogoAvatarIdentity } from "./lib/logo-avatar-activity";
import { identifyMonitoringUser } from "./lib/monitoring";
import { markAfterPaint, markOnce } from "./lib/performance";
import { lazyComponent } from "./lib/preload-recovery";
import { QueryUserProvider, setQueryUser } from "./lib/query";
import { getRemoteImagesEnabled, subscribeRemoteImages } from "./lib/remote-images-preference";
import { rpc } from "./lib/rpc";
import {
  holdAnonymousGate,
  holdUnreachableGate,
  sessionGate,
  sessionRetryDelayMs,
  showSessionUnavailable,
} from "./lib/session-gate";
import { syncLogOutFailure } from "./lib/sign-out";
import { completeSsoCallback, SSO_CALLBACK_PATH } from "./lib/sso-flow";
import { IntegrationCallbackPage } from "./pages/IntegrationCallback";
import { IntegrationSetupPage } from "./pages/IntegrationSetup";
import { McpOAuthCallbackPage } from "./pages/McpOAuthCallback";
import { ShellPage } from "./pages/Shell";
import { SlackInstallCallbackPage } from "./pages/SlackInstallCallback";

const AuthPage = lazyComponent(() => import("./pages/Auth").then((module) => module.AuthPage));
const PasswordResetPage = lazyComponent(() =>
  import("./pages/Auth").then((module) => module.PasswordResetPage),
);
const OnboardingPage = lazyComponent(() =>
  import("./pages/Onboarding").then((module) => module.OnboardingPage),
);
const WelcomePage = lazyComponent(() =>
  import("./pages/Welcome").then((module) => module.WelcomePage),
);
const ArtifactsPage = lazyComponent(() =>
  import("./pages/Artifacts").then((module) => module.ArtifactsPage),
);
const BoardPage = lazyComponent(() => import("./pages/Board").then((module) => module.BoardPage));
const AdminPluginsPage = lazyComponent(() =>
  import("./pages/AdminPluginsPage").then((module) => module.AdminPluginsPage),
);
const NavLinkPage = lazyComponent(() =>
  import("./pages/NavLinkPage").then((module) => module.NavLinkPage),
);

function SsoCallbackPage() {
  useEffect(() => {
    completeSsoCallback();
  }, []);
  return null;
}

// Link icons come from our API, which fetches and caches them; the browser never asks the site.
const linkFavicons: LinkFavicons = {
  load: (origin) => rpc.links.favicon({ origin }),
};

export function App() {
  const loadRemoteImages = useSyncExternalStore(
    subscribeRemoteImages,
    getRemoteImagesEnabled,
    () => false,
  );
  return (
    <RemoteImagesContext.Provider value={loadRemoteImages}>
      <LinkFaviconsContext.Provider value={linkFavicons}>
        <ErrorBoundary fallback={<AppFailed />}>
          {window.location.pathname === SSO_CALLBACK_PATH ? (
            <SsoCallbackPage />
          ) : window.location.pathname === "/integrations/callback" ? (
            <IntegrationCallbackPage />
          ) : (
            <SessionApp />
          )}
        </ErrorBoundary>
      </LinkFaviconsContext.Provider>
    </RemoteImagesContext.Provider>
  );
}

const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";
const SLACK_INSTALL_CALLBACK_PATH = "/messaging/slack/callback";

function SessionApp() {
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next") ?? "";
  // A connector sign-in started on another device lands here signed out; finish it after sign-in.
  const signInDestination =
    next === "/integrations/setup" ||
    next === "/admin/plugins" ||
    next.startsWith(`${MCP_OAUTH_CALLBACK_PATH}?`) ||
    next.startsWith(`${SLACK_INSTALL_CALLBACK_PATH}?`)
      ? next
      : "/app";
  const ticketBoardEnabled = useSyncExternalStore(
    subscribeTicketBoardEnabled,
    getTicketBoardEnabled,
    () => false,
  );
  const session = authClient.useSession();
  const { pathname, search } = useLocation();
  const screen = analyticsScreen(pathname);
  const analyticsUserId = session.data?.user.id;
  const lastScreen = useRef<string | undefined>(undefined);
  useEffect(() => {
    // A pending session is not a sign-out; startup already tagged the signed-in user.
    if (session.isPending) return;
    void identifyMonitoringUser(Boolean(analyticsUserId));
  }, [analyticsUserId, session.isPending]);
  useEffect(() => {
    if (!analyticsUserId) {
      lastScreen.current = undefined;
      return;
    }
    if (!screen) return;
    const key = `${analyticsUserId}:${screen}`;
    if (lastScreen.current === key) return;
    lastScreen.current = key;
    void Promise.resolve()
      .then(() => rpc.analytics.screen({ screen, surface: desktopBridge() ? "desktop" : "web" }))
      .catch(() => undefined);
  }, [analyticsUserId, screen]);
  const gate = sessionGate(session);
  useLayoutEffect(() => {
    if (gate !== "authenticated" && gate !== "anonymous") return;
    syncWebLogoAvatarIdentity(analyticsUserId ?? null);
    syncCallIdentity(analyticsUserId ?? null);
    syncLogOutFailure(gate === "authenticated");
  }, [gate, analyticsUserId]);
  useEffect(() => {
    if (gate === "authenticated" || gate === "anonymous") setQueryUser(analyticsUserId ?? null);
  }, [gate, analyticsUserId]);
  const [holdingUnreachable, setHoldingUnreachable] = useState(false);
  const nextHolding = holdUnreachableGate(gate, holdingUnreachable);
  if (nextHolding !== holdingUnreachable) setHoldingUnreachable(nextHolding);
  const [holdingAnonymous, setHoldingAnonymous] = useState(false);
  const nextHoldingAnonymous = holdAnonymousGate(gate, holdingAnonymous);
  if (nextHoldingAnonymous !== holdingAnonymous) setHoldingAnonymous(nextHoldingAnonymous);

  useLayoutEffect(() => {
    if (session.isPending) return;
    markOnce("rk:renderer:session-committed");
    markAfterPaint("rk:renderer:session-painted");
  }, [session.isPending]);

  if (showSessionUnavailable(gate, nextHolding)) {
    return <SessionUnavailable refetch={session.refetch} />;
  }
  if (gate === "loading" && !nextHoldingAnonymous) {
    return <PageLoading data-rakazo-app-state="session-pending" />;
  }

  const user = session.data?.user;
  return (
    <QueryUserProvider value={user?.id ?? null}>
      <MarkdownLinkPrompt>
        <div className="h-full" data-rakazo-app-state="ready">
          <Suspense fallback={<PageLoading />}>
            <Routes>
              <Route path="/" element={user ? <Navigate to="/app" replace /> : <WelcomePage />} />
              <Route
                path="/sign-in"
                element={
                  user ? (
                    <Navigate to={signInDestination} replace />
                  ) : (
                    <AuthPage key="in" mode="in" />
                  )
                }
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
                path={MCP_OAUTH_CALLBACK_PATH}
                element={
                  user ? (
                    <McpOAuthCallbackPage />
                  ) : (
                    <Navigate
                      to={`/sign-in?next=${encodeURIComponent(pathname + search)}`}
                      replace
                    />
                  )
                }
              />
              <Route
                path={SLACK_INSTALL_CALLBACK_PATH}
                element={
                  user ? (
                    <SlackInstallCallbackPage />
                  ) : (
                    <Navigate
                      to={`/sign-in?next=${encodeURIComponent(pathname + search)}`}
                      replace
                    />
                  )
                }
              />
              <Route
                path="/integrations/setup"
                element={
                  user ? (
                    <IntegrationSetupPage />
                  ) : (
                    <Navigate to="/sign-in?next=/integrations/setup" replace />
                  )
                }
              />
              <Route
                path="/admin/plugins"
                element={
                  user ? (
                    <AdminPluginsPage />
                  ) : (
                    <Navigate to="/sign-in?next=/admin/plugins" replace />
                  )
                }
              />
              <Route
                element={
                  user ? (
                    <SubscriptionGate fallback={<PageLoading />}>
                      <Outlet />
                    </SubscriptionGate>
                  ) : (
                    <Navigate to="/sign-in" replace />
                  )
                }
              >
                <Route path="/onboarding/:step?" element={<OnboardingPage />} />
                <Route path="/app" element={<ShellPage />} />
                <Route path="/app/g/:groupId" element={<ShellPage />} />
                <Route path="/app/artifacts" element={<ArtifactsPage />} />
                <Route path="/app/artifacts/:artifactId" element={<ArtifactsPage />} />
                {ticketBoardEnabled ? <Route path="/app/board" element={<BoardPage />} /> : null}
                <Route path="/app/x/:linkId" element={<NavLinkPage />} />
                <Route path="/app/:botId" element={<ShellPage />} />
              </Route>
            </Routes>
          </Suspense>
        </div>
      </MarkdownLinkPrompt>
    </QueryUserProvider>
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

/** Last resort for a render failure no inner boundary caught: offer a reload instead of a blank page. */
function AppFailed() {
  return (
    <div
      className="grid h-full place-items-center bg-background px-6 text-center"
      data-rakazo-app-state="failed"
    >
      <div className="flex flex-col items-center">
        <p className="text-[13.5px] text-muted-foreground/80">
          <Trans>Something went wrong. Try again.</Trans>
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={() => window.location.reload()}>
            <Trans>Refresh</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}
