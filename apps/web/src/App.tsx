import { lazy, Suspense, useLayoutEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { authClient } from "./lib/auth";
import { markAfterPaint, markOnce } from "./lib/performance";
import { ShellPage } from "./pages/Shell";

const AuthPage = lazy(() =>
  import("./pages/Auth").then((module) => ({ default: module.AuthPage })),
);
const OnboardingPage = lazy(() =>
  import("./pages/Onboarding").then((module) => ({ default: module.OnboardingPage })),
);
const WelcomePage = lazy(() =>
  import("./pages/Welcome").then((module) => ({ default: module.WelcomePage })),
);

export function App() {
  const session = authClient.useSession();
  useLayoutEffect(() => {
    if (session.isPending) return;
    markOnce("rk:renderer:session-committed");
    markAfterPaint("rk:renderer:session-painted");
  }, [session.isPending]);
  if (session.isPending) {
    return window.location.pathname.startsWith("/app") ? (
      <ShellSkeleton />
    ) : (
      <div className="grid h-full place-items-center text-[#6C6C70]">Loading…</div>
    );
  }
  const user = session.data?.user;
  return (
    <Suspense fallback={<div className="h-full bg-[#050506]" />}>
      <Routes>
        <Route path="/" element={user ? <Navigate to="/app" replace /> : <WelcomePage />} />
        <Route
          path="/sign-in"
          element={user ? <Navigate to="/app" replace /> : <AuthPage mode="in" />}
        />
        <Route
          path="/sign-up"
          element={user ? <Navigate to="/onboarding" replace /> : <AuthPage mode="up" />}
        />
        <Route
          path="/onboarding"
          element={user ? <OnboardingPage /> : <Navigate to="/sign-in" replace />}
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
  );
}

function ShellSkeleton() {
  return (
    <div className="flex h-full overflow-hidden bg-[#050506]">
      <aside className="hidden w-[316px] shrink-0 border-r border-[#171719] bg-[#0B0B0C] px-3.5 pt-16 md:block">
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
          Opening your workspace…
        </div>
        <div className="mx-6 mb-6 h-[54px] rounded-full border border-[#202023] bg-[#131315]" />
      </main>
    </div>
  );
}
