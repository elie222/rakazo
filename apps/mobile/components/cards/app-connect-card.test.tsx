// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { rpc, browser } = vi.hoisted(() => ({ rpc: vi.fn(), browser: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + (index ? values[index - 1] : "") + part, ""),
  }),
}));
vi.mock("../../lib/api/api", () => ({ rpc }));
vi.mock("../../lib/api/api-server", () => ({ apiBaseLoaded: async () => {} }));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: browser }));
vi.mock("../../lib/native/native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("../../lib/query/query", () => ({ refreshRpcQueries: vi.fn() }));
vi.mock("../../lib/thread/thread-read-only", () => ({ useThreadReadOnly: () => false }));
vi.mock("../integrations/connector-icon", () => ({ ConnectorIcon: () => null }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));

import { AppConnectCard } from "./AppConnectCard";

const block = {
  kind: "app_connect",
  connectorId: "fake",
  provider: "github",
  name: "GitHub",
  description: "Code",
  logo: null,
  status: "pending",
} as const;
const completes = () => rpc.mock.calls.filter(([name]) => name === "connections/complete");

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpc.mockImplementation(async (name: string) =>
    name === "connections/begin"
      ? {
          connectionId: "connection-1",
          authorizationUrl: "https://identity.example.test/authorize",
        }
      : { status: "pending" },
  );
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () =>
    root.render(<AppConnectCard botId="bot-1" threadId="thread-1" messageId="m" block={block} />),
  );
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("lands a finished sign-in even when the card left the screen meanwhile", async () => {
  const session = deferred<{ type: "success"; url: string }>();
  browser.mockReturnValue(session.promise);
  await act(async () => host.querySelector("button")!.click());
  await act(async () => root.unmount());
  await act(async () =>
    session.resolve({ type: "success", url: "rakazo://app-connect?connection=connection-1" }),
  );
  await vi.waitFor(() => expect(completes()).toHaveLength(1));
  expect(completes()[0]?.[1]).toEqual({ connectionId: "connection-1" });
});

it("reads once after a closed sign-in, in case the browser refused the hand-back", async () => {
  browser.mockResolvedValue({ type: "dismiss" });
  await act(async () => host.querySelector("button")!.click());
  await vi.waitFor(() => expect(completes()).toHaveLength(1));
  expect(host.querySelector("button")?.textContent).toBe("Connect");
  await act(async () => root.unmount());
});
