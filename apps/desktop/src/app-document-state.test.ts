// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_DOCUMENT_STATE_SCRIPT, waitForMountedAppDocument } from "./app-document-state.js";

function stateOf(html: string) {
  document.body.innerHTML = html;
  // Run the script the way the main process injects it into the renderer.
  return new Function(`return ${APP_DOCUMENT_STATE_SCRIPT};`)() as unknown;
}

describe("app document state", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("waits while the session is pending", () => {
    expect(
      stateOf(
        '<div id="root"><div data-rakazo-app-state="session-pending">Opening your Space…</div></div>',
      ),
    ).toBe("pending");
  });

  it("is ready once the session and a usable surface are mounted", () => {
    expect(
      stateOf(
        '<div id="root"><div data-rakazo-app-state="ready"><div data-testid="shell-root" data-ready="true"></div></div></div>',
      ),
    ).toBe("ready");
  });

  it("is ready on the marked onboarding page in any language", () => {
    expect(
      stateOf(
        '<div id="root"><div data-rakazo-app-state="ready"><div data-rakazo-surface="onboarding"><h1>Conectar un modelo</h1><div role="combobox" aria-label="Proveedor"></div></div></div></div>',
      ),
    ).toBe("ready");
  });

  it.each(["<button>Sign in</button>", '<input aria-label="Model id">'])(
    "still finds an older server's unmarked English page: %s",
    (surface) => {
      expect(
        stateOf(`<div id="root"><div data-rakazo-app-state="ready">${surface}</div></div>`),
      ).toBe("ready");
    },
  );

  it("reports the web app's error screen so launch keeps its Refresh", () => {
    expect(
      stateOf(
        '<div id="root"><div data-rakazo-app-state="failed"><p>Something went wrong. Try again.</p><button>Refresh</button></div></div>',
      ),
    ).toBe("failed");
  });
});

describe("waiting for the app document", () => {
  const disposed = () => Promise.reject(new Error("Render frame was disposed"));

  it("keeps waiting when a reload disposes the frame mid-check", async () => {
    const executeJavaScript = vi
      .fn()
      .mockImplementationOnce(disposed)
      .mockResolvedValueOnce("pending")
      .mockResolvedValue("ready");
    await expect(
      waitForMountedAppDocument({
        executeJavaScript,
        isCrashed: () => false,
        isDestroyed: () => false,
      }),
    ).resolves.toBe("ready");
    expect(executeJavaScript).toHaveBeenCalledTimes(3);
  });

  it("answers pending when the page is still loading at the deadline", async () => {
    await expect(
      waitForMountedAppDocument(
        { executeJavaScript: disposed, isCrashed: () => false, isDestroyed: () => false },
        200,
      ),
    ).resolves.toBe("pending");
  });

  it("gives up at once when the window is gone", async () => {
    await expect(
      waitForMountedAppDocument({
        executeJavaScript: disposed,
        isCrashed: () => false,
        isDestroyed: () => true,
      }),
    ).rejects.toThrow("Render frame was disposed");
  });
});
