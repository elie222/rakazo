// @vitest-environment jsdom
import type { RakazoDesktop } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PeerMessagesOverlay } from "./PeerMessagesOverlay";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/query/query", () => ({
  useSpaceQueries: () => ({ threads: { messages: { queryKey: () => ["messages"] } } }),
}));
vi.mock("../../lib/query/rpc", () => ({
  rpc: { threads: { messages: () => new Promise(() => undefined) } },
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.documentElement.removeAttribute("dir");
  delete window.rakazoDesktop;
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <PeerMessagesOverlay
          botId="bot-a"
          botName="Scout"
          botColor="blue"
          peerBotId="bot-b"
          peerBotName="Scribe"
          peerBotColor="green"
          onClose={() => undefined}
        />
      </QueryClientProvider>,
    ),
  );
  const view = document.querySelector('[data-testid="peer-conversation-view"]');
  if (!view) throw new Error("peer view did not open");
  return view;
}

it("clears the macOS window controls in the desktop app", async () => {
  window.rakazoDesktop = { platform: "darwin" } as RakazoDesktop;
  const view = await render();
  const header = view.firstElementChild!;
  expect(header.classList).toContain("app-drag");
  expect(header.querySelector('[aria-hidden="true"].app-drag')).not.toBeNull();
  expect(view.querySelector("button")?.classList).toContain("app-no-drag");
});

it("keeps the macOS header aligned to the native controls in RTL", async () => {
  document.documentElement.dir = "rtl";
  window.rakazoDesktop = { platform: "darwin" } as RakazoDesktop;
  const view = await render();
  const header = view.firstElementChild!;
  expect(header.getAttribute("dir")).toBe("ltr");
  expect(header.querySelector('[aria-hidden="true"].app-drag')).not.toBeNull();
  expect(header.querySelector('[dir="auto"]')?.textContent).toContain("Scout");
  expect(view.getAttribute("dir")).toBeNull();
});

it("leaves the header flush and inherited in an RTL browser", async () => {
  document.documentElement.dir = "rtl";
  const view = await render();
  const header = view.firstElementChild!;
  expect(header.getAttribute("dir")).toBeNull();
  expect(header.querySelector('[aria-hidden="true"].app-drag')).toBeNull();
});

it("does not override RTL for application-rendered window controls", async () => {
  document.documentElement.dir = "rtl";
  window.rakazoDesktop = { platform: "win32" } as RakazoDesktop;
  const view = await render();
  const header = view.firstElementChild!;
  expect(header.getAttribute("dir")).toBeNull();
  expect(header.querySelector('button[aria-label="Minimize"]')).not.toBeNull();
});
