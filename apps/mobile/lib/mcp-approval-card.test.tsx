// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { McpApprovalCard } from "../components/McpApprovalCard";

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
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
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
  kind: "mcp_approval",
  serverId: "server-1",
  name: "Files",
  endpoint: "https://mcp.example.test",
  status: "pending",
} as unknown as ComponentProps<typeof McpApprovalCard>["block"];

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
const render = () =>
  act(async () => root.render(<McpApprovalCard botId="bot-1" threadId="thread-1" block={block} />));

it("approves once on a double tap, holds both buttons, then shows it connected", async () => {
  await render();
  await act(async () => {
    button("Approve")!.click();
    button("Approve")!.click();
  });
  expect(rpc).toHaveBeenCalledExactlyOnceWith(
    "mcp/assignments/approve",
    { botId: "bot-1", serverId: "server-1", threadId: "thread-1" },
    { requestContext: expect.objectContaining({ apiBase: "http://api.test" }) },
  );
  expect(button("Not now")!.disabled).toBe(true);
  await act(async () => answer.resolve({}));
  expect(container.textContent).toContain("Connected.");
});

it("alerts a failed dismissal and offers both buttons again", async () => {
  await render();
  await act(async () => button("Not now")!.click());
  await act(async () => answer.reject(new Error("Offline")));
  expect(alert).toHaveBeenCalledWith("Could not complete action", "Offline");
  expect(button("Approve")!.disabled).toBe(false);
  expect(button("Not now")!.disabled).toBe(false);
});
