// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppRailLayout } from "./app-rail";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(path: string, enabled: boolean) {
  await act(async () =>
    root.render(
      <MemoryRouter key={path} initialEntries={[path]}>
        <Routes>
          <Route element={<AppRailLayout enabled={enabled} />}>
            <Route path="/app" element={<p>chats</p>} />
            <Route path="/app/board" element={<p>board</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
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

it("leaves the page alone when the board is off", async () => {
  await render("/app", false);
  expect(host.textContent).toContain("chats");
  expect(host.querySelector('[data-testid="app-rail"]')).toBeNull();
});
