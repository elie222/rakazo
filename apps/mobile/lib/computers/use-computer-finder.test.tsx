// @vitest-environment jsdom

import type { ComputerElement } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scope = vi.hoisted(() => ({ rpc: vi.fn(), alert: vi.fn() }));
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-a",
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-a" },
  }),
  rpc: scope.rpc,
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("react-native", () => ({ Alert: { alert: scope.alert } }));

import { useComputerFinder } from "./use-computer-finder";

const save: ComputerElement = {
  point: { x: 40, y: 30 },
  bbox: { x: 20, y: 20, w: 40, h: 20 },
  source: "ax",
  role: "push button",
  name: "Save",
  window: "notes.txt - Mousepad",
};

const requestContext = {
  apiBase: "https://app.example.test",
  sessionGeneration: 1,
  headers: { "x-rakazo-space-id": "space-a" },
};

let finder: ReturnType<typeof useComputerFinder>;
let root: Root;

function Screen() {
  finder = useComputerFinder("bot-1");
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  scope.rpc.mockReset();
  scope.alert.mockReset();
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Screen />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("computer finder", () => {
  it("lists the controls the screen answered", async () => {
    scope.rpc.mockResolvedValue({ elements: [save], truncated: false });
    await act(async () => finder.changeQuery("Save"));
    await act(async () => finder.runFind());
    await act(flush);

    expect(scope.rpc).toHaveBeenCalledWith(
      "computer/find",
      { botId: "bot-1", text: "Save", limit: 30 },
      { requestContext },
    );
    expect(finder.results).toEqual([save]);
  });

  it("reports a screen that did not answer instead of an empty list", async () => {
    scope.rpc.mockResolvedValue({ elements: [], truncated: false, unknown: true });
    await act(async () => finder.changeQuery("Save"));
    await act(async () => finder.runFind());
    await act(flush);

    expect(finder.find.error?.message).toBe("The screen did not answer in time.");
    expect(finder.results).toEqual([]);
  });

  it("clicks the chosen control at its point and closes the sheet", async () => {
    scope.rpc.mockResolvedValue({ ok: true });
    await act(async () => finder.openFinder());
    await act(async () => finder.chooseTarget(save));
    await act(flush);

    expect(scope.rpc).toHaveBeenCalledWith(
      "computer/input",
      { botId: "bot-1", kind: "pointer", payload: { x: 40, y: 30, type: "click" } },
      { requestContext },
    );
    expect(finder.open).toBe(false);
    expect(scope.alert).not.toHaveBeenCalled();
  });

  it("keeps the sheet open and explains a click that failed", async () => {
    scope.rpc.mockRejectedValue(new Error("The control is gone."));
    await act(async () => finder.openFinder());
    await act(async () => finder.chooseTarget(save));
    await act(flush);

    expect(scope.alert).toHaveBeenCalledWith(
      "Could not click that control.",
      "The control is gone.",
    );
    expect(finder.open).toBe(true);
  });
});
