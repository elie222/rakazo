import { StrictMode, useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { DesktopUpdatesProvider } from "./components/DesktopUpdates";
import { I18nBootstrap } from "./components/I18nBootstrap";
import { applyUiDirection } from "./lib/apply-ui-direction";
import { markAfterPaint, markOnce } from "./lib/performance";
import { installPreloadRecovery } from "./lib/preload-recovery";
import { applyUiAppearance, watchSystemAppearance } from "./lib/ui-appearance";
import { resolveUiLocale } from "./lib/ui-locale";
import "./styles.css";

markOnce("rk:renderer:module-evaluated");
installPreloadRecovery();
applyUiDirection(resolveUiLocale());
applyUiAppearance();

function PerformanceProbe() {
  useLayoutEffect(() => {
    markOnce("rk:renderer:first-react-commit");
    markAfterPaint("rk:renderer:first-react-painted");
  }, []);
  return null;
}

function AppearanceSync() {
  useEffect(() => watchSystemAppearance(), []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PerformanceProbe />
    <AppearanceSync />
    <I18nBootstrap>
      {/* Router state updates must not be transitions: under sustained urgent
          updates (SSE churn while a run streams) a pending navigation is
          preempted indefinitely — useSearchParams/useParams then keep serving
          the stale location, so deep links (?m=) and thread switches never
          land while the URL already moved. */}
      <BrowserRouter useTransitions={false}>
        <DesktopUpdatesProvider>
          <App />
        </DesktopUpdatesProvider>
      </BrowserRouter>
    </I18nBootstrap>
  </StrictMode>,
);
