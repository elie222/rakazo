import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { LinkFavicons } from "@rakazo/chat-ui/web";
import { LinkFaviconsContext, RemoteImagesContext } from "@rakazo/chat-ui/web";
import { mobileMcpOAuthReturnUrl } from "@rakazo/contracts";
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
import { SubscriptionGate } from "./components/billing/SubscriptionGate";
import { CallLayout } from "./components/call/CallLayout";
import { VoiceConsentPrompt } from "./components/call/VoiceConsentPrompt";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { MarkdownLinkPrompt } from "./components/messages/markdown-link-prompt";
import { PageLoading } from "./components/PageLoading";
import { authClient } from "./lib/auth/auth";
import { hasSignedInBefore, rememberSignedIn } from "./lib/auth/returning-user";
import {
  holdAnonymousGate,
  holdUnreachableGate,
  sessionGate,
  sessionRetryDelayMs,
  showSessionUnavailable,
} from "./lib/auth/session-gate";
import {
  MCP_OAUTH_CALLBACK_PATH,
  newAccountDestination,
  SLACK_INSTALL_CALLBACK_PATH,
  signInNext,
} from "./lib/auth/sign-in-next";
import { syncLogOutFailure } from "./lib/auth/sign-out";
import { completeSsoCallback, SSO_CALLBACK_PATH } from "./lib/auth/sso-flow";
import { getLabs, subscribeLabs } from "./lib/bootstrap";
import { syncWebLogoAvatarIdentity } from "./lib/bots/logo-avatar-activity";
import { syncCallIdentity } from "./lib/calls/call-session";
import { analyticsSurface } from "./lib/platform/desktop";
import { identifyMonitoringUser } from "./lib/platform/monitoring";
import { markAfterPaint, markOnce } from "./lib/platform/performance";
import { lazyComponent } from "./lib/platform/preload-recovery";
import { remoteImagesPreference } from "./lib/preferences/remote-images-preference";
import { QueryUserProvider, setQueryUser } from "./lib/query/query";
import { rpc } from "./lib/query/rpc";
import { IntegrationCallbackPage } from "./pages/integrations/IntegrationCallback";
import { IntegrationSetupPage } from "./pages/integrations/IntegrationSetup";
import { McpOAuthCallbackPage } from "./pages/integrations/McpOAuthCallback";
import { SlackInstallCallbackPage } from "./pages/integrations/SlackInstallCallback";
import { SharedPagePage } from "./pages/SharedPage";
import { ShellPage } from "./pages/Shell";

const AuthPage = lazyComponent(() => import("./pages/auth/Auth").then((module) => module.AuthPage));
const PasswordResetPage = lazyComponent(() =>
  import("./pages/auth/Auth").then((module) => module.PasswordResetPage),
);
const OnboardingPage = lazyComponent(() =>
  import("./pages/onboarding/Onboarding").then((module) => module.OnboardingPage),
);
const NotFoundPage = lazyComponent(() =>
  import("./pages/NotFound").then((module) => module.NotFoundPage),
);
const ArtifactsPage = lazyComponent(() =>
  import("./pages/space/Artifacts").then((module) => module.ArtifactsPage),
);
const BoardPage = lazyComponent(() =>
  import("./pages/space/Board").then((module) => module.BoardPage),
);
const AdminPluginsPage = lazyComponent(() =>
  import("./pages/plugins/AdminPluginsPage").then((module) => module.AdminPluginsPage),
);
const AdminAccessPage = lazyComponent(() =>
  import("./pages/auth/AdminAccessPage").then((module) => module.AdminAccessPage),
);
const NavLinkPage = lazyComponent(() =>
  import("./pages/NavLinkPage").then((module) => module.NavLinkPage),
);
const InvitePage = lazyComponent(() =>
  import("./pages/auth/Invite").then((module) => module.InvitePage),
);
const JoinOrganizationPage = lazyComponent(() =>
  import("./pages/auth/JoinOrganization").then((module) => module.JoinOrganizationPage),
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
  const loadRemoteImages = remoteImagesPreference.use();
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

function SessionApp() {
  const [searchParams] = useSearchParams();
  const next = signInNext(searchParams.get("next"));
  const boardEnabled = useSyncExternalStore(
    subscribeLabs,
    () => getLabs().includes("board"),
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
      .then(() => rpc.analytics.screen({ screen, surface: analyticsSurface() }))
      .catch(() => undefined);
  }, [analyticsUserId, screen]);
  const gate = sessionGate(session);
  useLayoutEffect(() => {
    if (gate !== "authenticated" && gate !== "anonymous") return;
    syncWebLogoAvatarIdentity(analyticsUserId ?? null);
    syncCallIdentity(analyticsUserId ?? null);
    syncLogOutFailure(gate === "authenticated");
    if (gate === "authenticated") rememberSignedIn();
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
      <VoiceConsentPrompt key={user?.id ?? "anonymous"} />
      <MarkdownLinkPrompt>
        <div className="h-full" data-rakazo-app-state="ready">
          <Suspense fallback={<PageLoading />}>
            <Routes>
              <Route
                path="/"
                element={
                  <Navigate
                    to={user ? "/app" : hasSignedInBefore() ? "/sign-in" : "/sign-up"}
                    replace
                  />
                }
              />
              {["/sign-in", "/sign-in/email"].map((path) => (
                <Route
                  key={path}
                  path={path}
                  element={
                    user ? (
                      <Navigate to={next ?? "/app"} replace />
                    ) : (
                      <AuthPage key={path} mode="in" />
                    )
                  }
                />
              ))}
              {["/sign-up", "/sign-up/email"].map((path) => (
                <Route
                  key={path}
                  path={path}
                  element={
                    user ? (
                      <Navigate to={newAccountDestination(next)} replace />
                    ) : (
                      <AuthPage key={path} mode="up" />
                    )
                  }
                />
              ))}
              <Route
                path="/forgot-password"
                element={
                  user ? <Navigate to="/app" replace /> : <AuthPage key="forgot" mode="forgot" />
                }
              />
              <Route path="/reset-password" element={<PasswordResetPage />} />
              <Route path="/p/:slugToken" element={<SharedPagePage />} />
              <Route
                path={MCP_OAUTH_CALLBACK_PATH}
                element={
                  // A sign-in the mobile app started goes back to the app, signed in here or not.
                  user || mobileMcpOAuthReturnUrl(new URLSearchParams(search)) ? (
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
                path="/join/:invitationId"
                element={
                  user ? (
                    <JoinOrganizationPage />
                  ) : (
                    <Navigate to={`/sign-in?next=${encodeURIComponent(pathname)}`} replace />
                  )
                }
              />
              <Route
                path="/invite/:token"
                element={
                  user ? (
                    <InvitePage />
                  ) : (
                    <Navigate to={`/sign-in?next=${encodeURIComponent(pathname)}`} replace />
                  )
                }
              />
              <Route
                path="/admin/access"
                element={
                  user ? <AdminAccessPage /> : <Navigate to="/sign-in?next=/admin/access" replace />
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
                <Route path="/app" element={<ShellPage />} />
                <Route path="/app/g/:groupId" element={<ShellPage />} />
                <Route path="/app/:botId" element={<ShellPage />} />
                <Route element={<CallLayout />}>
                  <Route path="/onboarding/:step?" element={<OnboardingPage />} />
                  <Route path="/app/artifacts" element={<ArtifactsPage />} />
                  <Route path="/app/artifacts/:artifactId" element={<ArtifactsPage />} />
                  {boardEnabled ? <Route path="/app/board" element={<BoardPage />} /> : null}
                  <Route path="/app/x/:linkId" element={<NavLinkPage />} />
                </Route>
              </Route>
              <Route path="*" element={<NotFoundPage />} />
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
  // Each retry is a new object, so a lookup that answers after Retry now cannot advance it.
  const [retry, setRetry] = useState({ attempt: 0, delay: sessionRetryDelayMs(0) });
  useTimeout(
    () => {
      const started = retry;
      void refetch().finally(() =>
        setRetry((current) =>
          current === started
            ? { attempt: started.attempt + 1, delay: sessionRetryDelayMs(started.attempt + 1) }
            : current,
        ),
      );
    },
    retry.delay,
    retry,
  );

  return (
    <div className="grid h-full place-items-center bg-background px-6 text-center">
      <div className="flex flex-col items-center">
        <LoadingState label={t`Reconnecting`} />
        <p className="mt-3 text-body text-muted-foreground/80">
          <Trans>Can&apos;t reach the server.</Trans>
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={() => setRetry({ attempt: 0, delay: 0 })}>
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
        <p className="text-body text-muted-foreground/80">
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
