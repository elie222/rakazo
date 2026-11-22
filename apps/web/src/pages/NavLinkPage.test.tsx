// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NavLinkPage } from "./NavLinkPage";

const state = vi.hoisted(() => ({
  rail: true,
  desktop: false,
  links: [{ id: "page-1", label: "Runbook", path: "https://example.test/runbook" }],
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/query/rpc", () => ({ rpc: { me: async () => ({ navLinks: state.links }) } }));
vi.mock("../lib/platform/desktop", () => ({
  desktopBridge: () => (state.desktop ? { platform: "darwin" } : undefined),
}));
vi.mock("../components/WindowChrome", () => ({
  WindowChrome: ({ className }: { className?: string }) => (
    <div data-testid="window-chrome" className={className} />
  ),
}));
vi.mock("./shell/app-rail", () => ({ useAppRail: () => state.rail }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.rail = true;
  state.desktop = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  host.remove();
  vi.unstubAllGlobals();
});

async function render(path: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/app/x/:linkId" element={<NavLinkPage />} />
            <Route path="/app" element={<p>Shell</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await flush();
  });
}

it("renders the custom page and hides window controls beside the rail", async () => {
  await render("/app/x/page-1");
  await vi.waitFor(() => expect(host.querySelector("iframe")).not.toBeNull());

  const iframe = host.querySelector("iframe");
  expect(iframe?.title).toBe("Runbook");
  expect(iframe?.getAttribute("src")).toBe("https://example.test/runbook");
  expect(host.textContent).toContain("Runbook");
  expect(host.querySelector('[data-testid="window-chrome"]')?.className).toContain("md:hidden");
  expect(host.querySelector('a[aria-label="Back"]')?.getAttribute("href")).toBe("/app");
});

it("keeps the window controls when there is no rail", async () => {
  state.rail = false;

  await render("/app/x/page-1");
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="window-chrome"]')).not.toBeNull(),
  );

  expect(host.querySelector('[data-testid="window-chrome"]')?.className).not.toContain("md:hidden");
});

it("returns to the shell for an unknown custom page", async () => {
  await render("/app/x/missing");
  await vi.waitFor(() => expect(host.textContent).toContain("Shell"));

  expect(host.textContent).toContain("Shell");
  expect(host.querySelector("iframe")).toBeNull();
});

it("returns to the shell in the desktop renderer", async () => {
  state.desktop = true;

  await render("/app/x/page-1");
  await vi.waitFor(() => expect(host.textContent).toContain("Shell"));

  expect(host.textContent).toContain("Shell");
  expect(host.querySelector("iframe")).toBeNull();
});
