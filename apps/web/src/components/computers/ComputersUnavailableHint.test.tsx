// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputersUnavailableHint } from "./ComputersUnavailableHint";

const { me } = vi.hoisted(() => ({ me: vi.fn() }));
vi.mock("../../lib/query/rpc", () => ({
  rpc: { health: async () => ({ ok: true }), me },
}));
vi.mock("@lingui/react/macro", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  me.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function buttonNamed(name: string) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === name);
}

it("keeps the focused retry and its companion controls while checking after a failure, and a second activation starts no check", async () => {
  const retryResult = deferred<{ sandboxProvider: string }>();
  me.mockRejectedValueOnce(new Error("Server unreachable")).mockReturnValueOnce(
    retryResult.promise,
  );
  await act(async () => {
    root.render(
      <ComputersUnavailableHint sandboxProvider="none" onOpenComputerSettings={vi.fn()} />,
    );
  });

  await act(async () => buttonNamed("Check again")?.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not verify computer setup",
  );
  const retry = buttonNamed("Check again");
  const settings = buttonNamed("Open computer settings");
  const help = host.querySelector("a");
  expect(retry).toBeDefined();
  expect(settings).toBeDefined();
  expect(help?.textContent).toBe("Setup help");
  retry?.focus();

  await act(async () => retry?.click());
  const checking = buttonNamed("Checking…");
  expect(checking).toBe(retry);
  expect(checking?.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(retry);
  expect(buttonNamed("Open computer settings")).toBe(settings);
  expect(host.querySelector("a")).toBe(help);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => checking?.click());
  expect(me).toHaveBeenCalledTimes(2);

  await act(async () => retryResult.resolve({ sandboxProvider: "none" }));
  expect(host.textContent).toContain("Computers are off on this server.");
  expect(buttonNamed("Check again")).toBe(retry);
  expect(retry?.getAttribute("aria-disabled")).not.toBe("true");
  expect(document.activeElement).toBe(retry);
});
