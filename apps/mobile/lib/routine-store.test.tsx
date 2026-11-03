// @vitest-environment jsdom
import type { Routine } from "@rakazo/contracts";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient, rpcQuery } from "./query";
import { useBotRoutines } from "./routine-store";

vi.mock("./api", () => ({
  rpc: vi.fn(),
  currentApiBase: () => "https://api.example",
  selectedSpaceId: () => "space-a",
  captureApiRequestContext: async () => ({}),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("expo-router", () => ({ useFocusEffect: () => {} }));

const routine = { id: "routine-1", createdAt: "2026-10-01T00:00:00Z", scheduleDelayed: true };
const key = rpcQuery("routines/list", { botId: "bot-1" }).queryKey;
let root: Root;
let container: HTMLDivElement;

// Query notifies its observers on the next tick.
async function update(change: () => void) {
  await act(async () => {
    change();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function Status() {
  const { routines } = useBotRoutines("bot-1");
  return createElement("span", null, routines?.[0]?.scheduleDelayed ? "delayed" : "on time");
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(createElement(Status)));
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  vi.unstubAllGlobals();
});

it("hides a delay seen before a failed read until a read answers again", async () => {
  const now = Date.now();
  await update(() => queryClient.setQueryData(key, [routine as Routine], { updatedAt: now + 1 }));
  expect(container.textContent).toBe("delayed");
  await update(() =>
    queryClient
      .getQueryCache()
      .find({ queryKey: key })
      ?.setState({ error: new Error("offline"), errorUpdatedAt: now + 2, status: "error" }),
  );
  expect(container.textContent).toBe("on time");
  await update(() => queryClient.setQueryData(key, [routine as Routine], { updatedAt: now + 3 }));
  expect(container.textContent).toBe("delayed");
});
