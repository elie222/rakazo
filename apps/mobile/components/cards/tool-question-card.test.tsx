// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileArtifactTarget } from "../../lib/artifacts/artifact-open";
import { ToolQuestionCard } from "./ToolQuestionCard";

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
vi.mock("../../lib/native/native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => (
    <span data-role={accessibilityRole}>{children}</span>
  ),
}));
vi.mock("../native/native-action-button", () => ({
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
vi.mock("../native/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../ui/menu-picker", () => ({ MenuPicker: () => null }));

const block = {
  kind: "tool_question",
  status: "pending",
  question: { source: "Calendar", message: "Add this event?", fields: [] },
} as unknown as Extract<MessageBlock, { kind: "tool_question" }>;
const target: MobileArtifactTarget = { botId: "bot-1" };

let root: Root;
let container: HTMLDivElement;
let answer: Deferred<unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  answer = deferred();
  rpc.mockImplementation(() => answer.promise);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label);
const render = (props: Partial<ComponentProps<typeof ToolQuestionCard>> = {}) =>
  act(async () =>
    root.render(
      <ToolQuestionCard block={block} messageId="message-1" target={target} canAnswer {...props} />,
    ),
  );

it("announces a failed answer as an alert", async () => {
  await render();
  await act(async () => button("Accept")!.click());
  expect(rpc).toHaveBeenCalledWith(
    "threads/answerToolQuestion",
    expect.objectContaining({ botId: "bot-1", messageId: "message-1", action: "accept" }),
    expect.anything(),
  );
  await act(async () => answer.reject(new Error("Offline")));
  const failure = [...container.querySelectorAll("span")].find(
    (item) => item.textContent === "Offline",
  );
  expect(failure?.dataset.role).toBe("alert");
  expect(button("Accept")!.disabled).toBe(false);
});
