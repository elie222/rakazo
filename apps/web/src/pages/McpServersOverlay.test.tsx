// @vitest-environment jsdom
import type { McpServer } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { McpServersOverlay } from "./McpServersOverlay";

const mocks = vi.hoisted(() => ({ list: vi.fn(), test: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: {
    mcp: { servers: mocks, assignments: { all: async () => [] } },
    bots: { list: async () => [] },
  },
}));
vi.mock("../lib/mcp-connect", () => ({
  MCP_OAUTH_CHANNEL: "test",
  mcpOAuthRedirectUri: () => "",
  connectMcpOauth: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + (i ? String(values[i - 1]) : "") + part, ""),
  }),
}));
vi.mock("@rakazo/ui-web", async () => {
  const { createElement } = await import("react");
  const container = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return Object.fromEntries([
    ...[
      "Badge",
      "Card",
      "CardContent",
      "CardHeader",
      "CardTitle",
      "Dialog",
      "DialogClose",
      "DialogContent",
      "DialogHeader",
      "DialogTitle",
      "Field",
      "FieldError",
      "FieldGroup",
      "FieldLabel",
      "FieldTitle",
      "Tabs",
      "TabsList",
      "TabsTrigger",
      "Toggle",
    ].map((name) => [name, container]),
    [
      "Button",
      ({
        children,
        onClick,
        disabled,
      }: {
        children: ReactNode;
        onClick: () => void;
        disabled: boolean;
      }) => createElement("button", { onClick, disabled }, children),
    ],
    ["Input", () => null],
    ["Textarea", () => null],
    ["toast", { success: vi.fn(), error: vi.fn() }],
  ]);
});

it("keeps each concurrent connection test busy until its own request finishes", async () => {
  const servers = ["one", "two"].map(
    (id) =>
      ({
        id,
        name: id,
        transport: "stdio",
        oauthStatus: "none",
        health: { status: "unknown" },
        enabled: true,
      }) as McpServer,
  );
  mocks.list.mockResolvedValue(servers);
  const finish = new Map<string, (server: McpServer) => void>();
  mocks.test.mockImplementation(
    ({ id }: { id: string }) => new Promise((resolve) => finish.set(id, resolve)),
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<McpServersOverlay onClose={() => {}} />));
    const buttons = Array.from(host.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Test connection"),
    );
    expect(buttons).toHaveLength(2);
    await act(async () => {
      buttons[0]?.click();
      buttons[1]?.click();
    });
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await act(async () => finish.get("two")?.(servers[1] as McpServer));
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[1]?.disabled).toBe(false);
    await act(async () => finish.get("one")?.(servers[0] as McpServer));
    expect(buttons.every((button) => !button.disabled)).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  [403, 2],
  [404, 2],
  [503, 5],
])("after a %i install poll, list requests total %i", async (status, requests) => {
  vi.useFakeTimers();
  const installing = {
    id: "one",
    name: "one",
    transport: "stdio",
    oauthStatus: "none",
    health: { status: "installing" },
    enabled: true,
  } as McpServer;
  mocks.list
    .mockReset()
    .mockResolvedValueOnce([installing])
    .mockRejectedValueOnce(Object.assign(new Error("Refused"), { status }))
    .mockResolvedValue([installing]);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<McpServersOverlay onClose={() => {}} />));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.list).toHaveBeenCalledTimes(requests);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
