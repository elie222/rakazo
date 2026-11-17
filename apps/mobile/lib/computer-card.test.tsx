// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerCard } from "../components/ComputerCard";
import { queryClient } from "./query";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), alert: vi.fn() }));
vi.mock("./api", () => ({
  rpc: mocks.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async (spaceId: string | null = "space-1") => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("./thread-read-only", () => ({ useThreadReadOnly: () => false }));
vi.mock("./message-presentation", () => ({ threadCardWidth: () => 300 }));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    useEffect(() => callback(), [callback]);
  },
}));
vi.mock("@rakazo/chat-ui/native", () => ({ ChatMarkdown: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    busy,
  }: {
    label: string;
    onPress: () => void;
    busy?: boolean;
  }) => (
    <button type="button" data-busy={String(Boolean(busy))} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    Pressable: View,
    Text: View,
    Image: ({ source }: { source: { uri: string } }) => <img alt="" src={source.uri} />,
    Alert: { alert: mocks.alert },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 400 }),
  };
});

// Cache updates reach the card inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

const block = {
  kind: "computer",
  state: "Needs you",
  text: "Sign in to the site",
} as Parameters<typeof ComputerCard>[0]["block"];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label);
const releases = () => mocks.rpc.mock.calls.filter(([path]) => path === "computer/release");

async function render() {
  await act(async () =>
    root.render(
      <ComputerCard block={block} botId="bot-1" runId="run-1" onOpen={() => undefined} />,
    ),
  );
}

it("shows the waiting screen and sends one answer for a double tap, staying busy after it", async () => {
  const answer = deferred<unknown>();
  mocks.rpc.mockImplementation(async (path: string) =>
    path === "computer/preview" ? { image: "data:image/png;base64,AAAA" } : answer.promise,
  );
  await render();
  await vi.waitFor(() => expect(container.querySelector("img")).not.toBeNull());
  await act(async () => {
    button("Skip")?.click();
    button("Skip")?.click();
  });
  await act(async () => answer.resolve({ ok: true }));
  expect(releases()).toHaveLength(1);
  expect(releases()[0]?.[1]).toEqual({ botId: "bot-1", runId: "run-1", reason: "skipped" });
  expect(button("Skip")?.dataset.busy).toBe("true");
});

it("says why an answer failed and offers it again", async () => {
  mocks.rpc.mockImplementation(async (path: string) => {
    if (path === "computer/preview") return { image: null };
    throw new Error("offline");
  });
  await render();
  await act(async () => button("I’m done")?.click());
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledTimes(1));
  expect(mocks.alert.mock.calls[0]?.[0]).toBe("Could not continue");
  expect(button("I’m done")?.dataset.busy).toBe("false");
});
