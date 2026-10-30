/**
 * Empty `#root` shells and session-pending skeletons count as loaded HTML but are
 * not a usable app. After session resolves, wait for a bootstrapped shell
 * (`data-ready` / shell-ready mark) or an auth/welcome/onboarding surface so a
 * bare Suspense fallback or pre-bootstrap ShellPage cannot pass. Plain e2e
 * fixtures omit the Rakazo app-state marker. Runs in the renderer.
 */
export const APP_DOCUMENT_STATE_SCRIPT = `(() => {
  const appState =
    document.querySelector("[data-rakazo-app-state]")?.getAttribute("data-rakazo-app-state") ??
    null;
  if (appState === "session-pending") return "pending";
  // The web app's last-resort error screen: keep it so its Refresh can recover.
  if (appState === "failed") return "failed";

  const shell = document.querySelector('[data-testid="shell-root"]');
  const shellBootstrapped = Boolean(
    (shell && shell.getAttribute("data-ready") === "true") ||
      performance.getEntriesByName("rk:renderer:shell-ready").length > 0,
  );
  const authOrWelcomeSurface = Boolean(
    document.querySelector('[data-rakazo-surface="welcome"]') ||
      document.querySelector(
        'form input[type="email"], form input[name="email"], form input#email',
      ) ||
      Array.from(document.querySelectorAll("button")).some((button) =>
        /sign\\s*in/i.test((button.textContent || "").trim()),
      ) ||
      document.querySelector(
        '[aria-label="Model"], [aria-label="Model id"], [aria-label="Models from server"]',
      ),
  );
  const surfaceReady = shellBootstrapped || authOrWelcomeSurface;
  const sessionReady =
    appState === "ready" ||
    performance.getEntriesByName("rk:renderer:session-committed").length > 0;
  if (sessionReady && surfaceReady) return "ready";

  // Desktop e2e fixtures mount a plain page without Rakazo app-state markers.
  if (appState === null) {
    const bodyText = (document.body?.innerText || "").trim();
    if (bodyText.includes("Opening your Space")) return "pending";
    if (bodyText === "Loading…" || bodyText === "Loading...") return "pending";
    const mainText = (document.querySelector("main")?.textContent || "").trim();
    const rootChildren = document.getElementById("root")?.childElementCount ?? 0;
    return mainText.length > 0 || rootChildren > 0 ? "ready" : "pending";
  }
  return "pending";
})()`;

/** `pending`: the page is still loading when the wait ends, for instance on a slow server. */
export type AppDocumentState = "ready" | "failed" | "pending";

type DocumentContents = Pick<
  Electron.WebContents,
  "executeJavaScript" | "isCrashed" | "isDestroyed"
>;

export async function waitForMountedAppDocument(
  contents: DocumentContents,
  timeoutMs = 20_000,
): Promise<AppDocumentState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (contents.isCrashed()) throw new Error("Renderer stopped after load.");
    let state: AppDocumentState;
    try {
      state = (await contents.executeJavaScript(APP_DOCUMENT_STATE_SCRIPT)) as AppDocumentState;
    } catch (error) {
      // A reload or redirect during startup disposes the frame being asked; ask the next document.
      if (contents.isDestroyed()) throw error;
      state = "pending";
    }
    if (state !== "pending") return state;
    await new Promise((r) => setTimeout(r, 50));
  }
  return "pending";
}
