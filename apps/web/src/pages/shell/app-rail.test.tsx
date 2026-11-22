// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as RpcModule from "../../lib/query/rpc";
import { AppRailLayout } from "./app-rail";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/auth/auth", () => ({
  authClient: { useSession: () => ({ data: null }) },
}));
vi.mock("../../lib/query/rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof RpcModule>();
  return {
    ...actual,
    rpc: new Proxy(actual.rpc, {
      get(target, property, receiver) {
        if (property === "me") return () => Promise.resolve({ navLinks: [] });
        return Reflect.get(target, property, receiver);
      },
    }),
  };
});
vi.mock("./sidebar/shell-sidebar-footer", () => ({
  ShellSidebarFooter: () => <div data-testid="rail-footer" />,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  host.remove();
});

async function render(path: string, boardEnabled: boolean) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter key={path} initialEntries={[path]}>
          <Routes>
            <Route element={<AppRailLayout boardEnabled={boardEnabled} />}>
              <Route path="/app" element={<p>chats</p>} />
              <Route path="/app/board" element={<p>board</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

function current() {
  return host
    .querySelector('[data-testid="app-rail"] [aria-current="page"]')
    ?.getAttribute("aria-label");
}

it("marks the section on screen", async () => {
  await render("/app", true);
  expect(host.textContent).toContain("chats");
  expect(current()).toBe("Chats");
  await render("/app/board", true);
  expect(host.textContent).toContain("board");
  expect(current()).toBe("Board");
  await render("/app/board/", true);
  expect(current()).toBe("Board");
});

it("keeps the rail but leaves Board out when the board is off", async () => {
  await render("/app", false);
  expect(host.textContent).toContain("chats");
  expect(host.querySelector('[data-testid="app-rail"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="app-rail"] [aria-label="Board"]')).toBeNull();
  expect(current()).toBe("Chats");
});

it("treats /app/board as a chat when the board lab is off", async () => {
  await render("/app/board", false);
  expect(host.querySelector('[data-testid="rail-footer"]')).toBeNull();

  await render("/app/board", true);
  expect(host.querySelector('[data-testid="rail-footer"]')).not.toBeNull();
});
