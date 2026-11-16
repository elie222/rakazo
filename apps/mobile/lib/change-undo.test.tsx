// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangeUndo } from "../components/change-undo";

const { rpc, alert } = vi.hoisted(() => ({ rpc: vi.fn(), alert: vi.fn() }));
vi.mock("./api", () => ({
  rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async () => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-1" },
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("react-native", () => ({
  Alert: { alert },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));

const block = {
  kind: "ask",
  settingsUpdate: { botId: "bot-1", before: { name: "Old" }, after: { name: "New" } },
} as unknown as ComponentProps<typeof ChangeUndo>["block"];

let root: Root;
let container: HTMLDivElement;
let undo: Deferred<unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  undo = deferred();
  rpc.mockImplementation(() => undo.promise);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = () => container.querySelector("button")!;

it("undoes once on a double tap and then shows it restored", async () => {
  await act(async () => root.render(<ChangeUndo block={block} />));
  await act(async () => {
    button().click();
    button().click();
  });
  expect(rpc).toHaveBeenCalledExactlyOnceWith(
    "bots/update",
    { botId: "bot-1", name: "Old", expectedSettings: { name: "New" } },
    { requestContext: expect.objectContaining({ apiBase: "http://api.test" }) },
  );
  expect(button().disabled).toBe(true);
  await act(async () => undo.resolve({}));
  expect(button().textContent).toBe("Restored");
  expect(button().disabled).toBe(true);
});

it("alerts a failure and offers Undo again", async () => {
  await act(async () => root.render(<ChangeUndo block={block} />));
  await act(async () => button().click());
  await act(async () => undo.reject(new Error("Changed since")));
  expect(alert).toHaveBeenCalledWith("Changed since");
  expect(button().textContent).toBe("Undo");
  expect(button().disabled).toBe(false);
});
