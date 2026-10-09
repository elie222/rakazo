// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { APP_DOCUMENT_STATE_SCRIPT } from "./app-document-state.js";

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

  it("reports the web app's error screen so launch keeps its Refresh", () => {
    expect(
      stateOf(
        '<div id="root"><div data-rakazo-app-state="failed"><p>Something went wrong. Try again.</p><button>Refresh</button></div></div>',
      ),
    ).toBe("failed");
  });
});
