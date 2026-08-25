import { StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { applyUiDirection } from "./lib/apply-ui-direction";
import { markAfterPaint, markOnce } from "./lib/performance";
import "./styles.css";

markOnce("rk:renderer:module-evaluated");
applyUiDirection();

function PerformanceProbe() {
  useLayoutEffect(() => {
    markOnce("rk:renderer:first-react-commit");
    markAfterPaint("rk:renderer:first-react-painted");
  }, []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PerformanceProbe />
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
