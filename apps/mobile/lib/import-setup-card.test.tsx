// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImportSetupCard } from "../components/ImportSetupCard";
import type { ImportSetupBlock } from "./import-setup";
import { queryClient } from "./query";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc: mocks.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("./thread-read-only", () => ({ useThreadReadOnly: () => false }));
vi.mock("./message-presentation", () => ({ threadCardWidth: () => 300 }));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    useEffect(() => callback(), [callback]);
  },
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({ NativeActionButton: () => null }));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    Text: View,
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ width: 400 }),
  };
});

const items: ImportSetupBlock["items"] = [
  { kind: "routine", routineId: "routine-1", name: "Digest" },
];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  mocks.rpc
    .mockReset()
    .mockResolvedValueOnce({ providers: {}, serverIds: {}, routineIds: { "routine-1": false } })
    .mockResolvedValue({ providers: {}, serverIds: {}, routineIds: { "routine-1": true } });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function render(block: ImportSetupBlock) {
  await act(async () => root.render(<ImportSetupCard botId="bot-1" block={block} />));
  await act(flush);
}

it("reads the checklist again when the thread brings a new block with the same items", async () => {
  await render({ kind: "import_setup", items });
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain("Setup complete");
  await render({ kind: "import_setup", items: [...items] });
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Setup complete");
});
