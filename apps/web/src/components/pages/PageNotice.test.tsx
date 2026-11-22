// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageLoading, PageNotice } from "./PageNotice";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("exposes one loading status separately from the decorative skeleton", async () => {
  await act(async () => root.render(<PageLoading />));

  const skeleton = host.querySelector('[data-testid="page-loading"]');
  expect(skeleton?.getAttribute("aria-hidden")).toBe("true");
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  const status = host.querySelector('[role="status"]');
  expect(status?.textContent).toBe("Loading page…");
  expect(status?.classList.contains("sr-only")).toBe(true);
  expect(status?.closest('[aria-hidden="true"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("removes loading status when an error replaces it and keeps Retry usable", async () => {
  const retry = vi.fn();
  await act(async () => root.render(<PageLoading />));
  await act(async () =>
    root.render(
      <PageNotice title="Could not open page" detail="Try again later." onRetry={retry} />,
    ),
  );

  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelector('[data-testid="page-loading"]')).toBeNull();
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("Could not open page");
  const button = alert?.querySelector("button");
  expect(button?.textContent).toBe("Try again");
  await act(async () => button?.click());
  expect(retry).toHaveBeenCalledOnce();
});
