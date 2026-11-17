// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/query/query";
import { SpaceAvailabilityPicker } from "./space-availability";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
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
const render = () =>
  act(async () =>
    root.render(
      <SpaceAvailabilityPicker
        kind="install"
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
});

it("says why a choice was refused", async () => {
  await render();
  await act(async () => button("Work").click());
  await act(async () => saved.reject(new Error("Name already used in Work")));
  expect(container.textContent).toContain("Name already used in Work");
});
