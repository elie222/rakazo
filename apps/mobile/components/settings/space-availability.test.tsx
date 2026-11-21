// @vitest-environment jsdom

import type { AvailabilityKind } from "@rakazo/contracts";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { announceToScreenReader } from "../../lib/native/announce";
import { queryClient } from "../../lib/query/query";
import { SpaceAvailabilityPicker } from "./space-availability";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../../lib/native/announce", () => ({ announceToScreenReader: vi.fn() }));
vi.mock("../../lib/api/api", () => ({
  rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async () => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-1" },
  }),
}));
vi.mock("../../lib/api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../../lib/appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span role="alert">{children}</span>,
}));
vi.mock("../ui/menu-picker", () => ({
  MenuPicker: ({
    choices,
    onChange,
  }: {
    choices: { key: string; label: string }[];
    onChange: (key: string) => void;
  }) => (
    <>
      {choices.map((choice) => (
        <button key={choice.key} type="button" onClick={() => onChange(choice.key)}>
          {choice.label}
        </button>
      ))}
    </>
  ),
}));
// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

let root: Root;
let container: HTMLDivElement;
let saved: Deferred<unknown>;
const stale = [["installs"]];
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  saved = deferred();
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "spaces/list"
      ? {
          spaces: [
            { id: "space-1", name: "Home" },
            { id: "space-2", name: "Work" },
          ],
        }
      : saved.promise,
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
const render = (kind: AvailabilityKind = "install") =>
  act(async () =>
    root.render(
      <SpaceAvailabilityPicker
        kind={kind}
        id="install-1"
        availability={{ allSpaces: true, spaceIds: ["space-1"] }}
        stale={stale}
      />,
    ),
  );
const changes = () => rpc.mock.calls.filter(([procedure]) => procedure === "availability/set");

it("sends one change at a time and reads the item again after it", async () => {
  await render();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  await act(async () => {
    button("Work").click();
    button("Home").click();
  });
  expect(changes()).toEqual([
    [
      "availability/set",
      { kind: "install", id: "install-1", allSpaces: false, spaceIds: ["space-2"] },
      { requestContext: expect.objectContaining({ apiBase: "http://api.test" }) },
    ],
  ]);
  await act(async () => saved.resolve({}));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: stale[0] });
  expect(announceToScreenReader).not.toHaveBeenCalled();
});

const renderSeveral = () =>
  act(async () =>
    root.render(
      <SpaceAvailabilityPicker
        kind="install"
        id="install-1"
        availability={{ allSpaces: false, spaceIds: ["space-1", "space-2"] }}
        stale={stale}
      />,
    ),
  );

it("labels several spaces as a count in English", async () => {
  await renderSeveral();
  expect(container.textContent).toContain("2 spaces");
});

it.each(["install", "skill"] as const)(
  "announces why a %s choice was refused once, including a repeated failure",
  async (kind) => {
    await render(kind);
    expect(announceToScreenReader).not.toHaveBeenCalled();
    for (const attempt of [1, 2]) {
      saved = deferred();
      await act(async () => button("Work").click());
      expect(announceToScreenReader).toHaveBeenCalledTimes(attempt - 1);
      await act(async () => saved.reject(new Error("Name already used in Work")));
      const reason = container.querySelector('[role="alert"]')?.textContent;
      expect(reason).toBe("Name already used in Work");
      expect(announceToScreenReader).toHaveBeenCalledTimes(attempt);
      expect(announceToScreenReader).toHaveBeenNthCalledWith(attempt, reason);
    }
    expect(changes()).toHaveLength(2);
  },
);

it("announces the displayed fallback when a refusal has no message", async () => {
  await render();
  await act(async () => button("Work").click());
  await act(async () => saved.reject(new Error("")));
  const reason = container.querySelector('[role="alert"]')?.textContent;
  expect(reason).toBe("Could not change where this is available");
  expect(announceToScreenReader).toHaveBeenCalledExactlyOnceWith(reason);
});

it("does not announce success after a refused choice", async () => {
  await render();
  await act(async () => button("Work").click());
  await act(async () => saved.reject(new Error("Name already used in Work")));
  expect(announceToScreenReader).toHaveBeenCalledTimes(1);
  saved = deferred();
  await act(async () => button("Home").click());
  await act(async () => saved.resolve({}));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(announceToScreenReader).toHaveBeenCalledTimes(1);
});

it.each(["success", "failure"])("does not announce a late %s after leaving", async (outcome) => {
  await render();
  await act(async () => button("Work").click());
  expect(changes()).toHaveLength(1);
  await act(async () => root.render(null));
  await act(async () => {
    if (outcome === "failure") saved.reject(new Error("Name already used in Work"));
    else saved.resolve({});
  });
  expect(announceToScreenReader).not.toHaveBeenCalled();
});
