// @vitest-environment jsdom
import type { McpServer } from "@rakazo/contracts";
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { connectMcpOauth } from "../lib/mcp-connect";
import { McpServersOverlay } from "./McpServersOverlay";

const mocks = vi.hoisted(() => ({ list: vi.fn(), test: vi.fn(), update: vi.fn() }));
const access = vi.hoisted(() => ({ all: vi.fn(), replace: vi.fn(), bots: vi.fn() }));
const api = vi.hoisted(() => ({
  mcp: { servers: mocks, assignments: { all: access.all, replace: access.replace } },
  bots: { list: access.bots },
}));
// One space, so no "Available in" choice appears.
vi.mock("../components/integrations/space-availability", () => ({
  AvailabilityControl: () => null,
  AvailabilityLabel: () => null,
  reachesOtherSpaces: () => false,
  useOwnSpaces: () => [],
}));

vi.mock("../lib/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("../lib/mcp-connect", () => ({
  MCP_OAUTH_CHANNEL: "test",
  mcpOAuthRedirectUri: () => "",
  connectMcpOauth: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  Plural: () => null,
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
      "SectionHeading",
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
    [
      "Input",
      ({ id, value, placeholder }: { id?: string; value?: string; placeholder?: string }) =>
        createElement("input", { id, value, placeholder, readOnly: true }),
    ],
    ["Textarea", () => null],
    ["toast", { success: vi.fn(), error: vi.fn() }],
  ]);
});

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  access.all.mockReset().mockResolvedValue([]);
  access.replace.mockReset().mockResolvedValue([]);
  access.bots.mockReset().mockResolvedValue([]);
});

function overlay(editServerId?: string, stdioEnabled = true) {
  return (
    <QueryClientProvider client={client}>
      <McpServersOverlay
        editServerId={editServerId}
        stdioEnabled={stdioEnabled}
        onClose={() => {}}
      />
    </QueryClientProvider>
  );
}

function server(id: string, status = "unknown") {
  return {
    id,
    name: id,
    transport: "stdio",
    oauthStatus: "none",
    health: { status },
    enabled: true,
  } as McpServer;
}

it("offers stdio only where the deployment runs it, and still shows existing stdio servers", async () => {
  mocks.list
    .mockReset()
    .mockResolvedValue([
      { ...server("files"), hasArgs: false, envKeys: [], fileKeys: [], headerKeys: [] },
    ]);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(overlay(undefined, false)));
    await vi.waitFor(() => expect(host.textContent).toContain("files"));
    expect(host.textContent).not.toContain("STDIO");

    // Editing an existing stdio server keeps its tab until the edit ends.
    await act(async () => root.render(overlay("files", false)));
    await vi.waitFor(() => expect(host.textContent).toContain("STDIO"));
    const cancel = Array.from(host.querySelectorAll("button")).find(
      (item) => item.textContent === "Cancel",
    );
    await act(async () => cancel?.click());
    expect(host.textContent).not.toContain("STDIO");

    await act(async () => root.render(overlay()));
    expect(host.textContent).toContain("STDIO");
  } finally {
    await act(async () => root.unmount());
  }
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
    await act(async () => root.render(overlay()));
    await vi.waitFor(() => expect(host.textContent).toContain("Test connection"));
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
    await act(async () => root.render(overlay()));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.list).toHaveBeenCalledTimes(requests);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("opens a server's form and saves it in place, sending blank values to keep what is stored", async () => {
  const server = {
    id: "srv_1",
    slug: "docs",
    name: "docs",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.example.test/mcp",
    command: null,
    hasArgs: false,
    envKeys: [],
    fileKeys: [],
    headerKeys: ["Authorization", "X-Team"],
    oauthStatus: "none",
    oauthClientId: null,
    hasSecret: false,
    health: { status: "unknown" },
    enabled: true,
  } as unknown as McpServer;
  mocks.list.mockReset().mockResolvedValue([server]);
  mocks.update.mockReset().mockResolvedValue(server);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(overlay("srv_1")));
    const save = await vi.waitFor(() => {
      const button = Array.from(host.querySelectorAll("button")).find(
        (item) => item.textContent === "Save",
      );
      expect(button).toBeDefined();
      return button;
    });
    await act(async () => save?.click());
    expect(mocks.update).toHaveBeenCalledWith({
      id: "srv_1",
      config: expect.objectContaining({
        slug: "docs",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        headers: { Authorization: "", "X-Team": "" },
      }),
    });
  } finally {
    await act(async () => root.unmount());
  }
});

it("points a server that cannot register a client at the client ID fields", async () => {
  const remote = {
    id: "srv_1",
    slug: "docs",
    name: "docs",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.example.test/mcp",
    command: null,
    hasArgs: false,
    envKeys: [],
    fileKeys: [],
    headerKeys: [],
    oauthStatus: "none",
    oauthClientId: null,
    hasSecret: false,
    health: { status: "unknown" },
    enabled: true,
  } as unknown as McpServer;
  const needsClient = {
    ...remote,
    health: { status: "error", code: MCP_OAUTH_CLIENT_REQUIRED },
  } as unknown as McpServer;
  mocks.list.mockReset().mockResolvedValueOnce([remote]).mockResolvedValue([needsClient]);
  vi.mocked(connectMcpOauth).mockRejectedValueOnce(
    Object.assign(new Error("Incompatible auth server"), { code: MCP_OAUTH_CLIENT_REQUIRED }),
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  const button = (label: string) =>
    Array.from(host.querySelectorAll("button")).find((item) => item.textContent === label);
  const advancedOpen = () =>
    host.querySelector('[data-slot="disclosure"]')?.hasAttribute("data-open") ?? false;
  try {
    await act(async () => root.render(overlay()));
    await vi.waitFor(() => expect(button("Connect OAuth")).toBeDefined());
    expect(advancedOpen()).toBe(false);

    await act(async () => button("Connect OAuth")?.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Needs an OAuth client ID");
    expect(button("Save")).toBeDefined();
    expect(advancedOpen()).toBe(true);

    // The server now says why, and a sign-in that cannot work is no longer offered.
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="mcp-health"]')?.textContent).toContain(
        "Needs an OAuth client ID",
      ),
    );
    expect(button("Connect OAuth")).toBeUndefined();
    await act(async () => button("Cancel")?.click());
    expect(advancedOpen()).toBe(false);
    await act(async () => button("Edit")?.click());
    expect(advancedOpen()).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

it("never shows stored stdio arguments and sends none back when they were not edited", async () => {
  const server = {
    id: "srv_2",
    slug: "files",
    name: "files",
    description: "",
    transport: "stdio",
    endpoint: null,
    command: "npx",
    hasArgs: true,
    envKeys: [],
    fileKeys: [],
    headerKeys: [],
    oauthStatus: "none",
    oauthClientId: null,
    hasSecret: false,
    health: { status: "unknown" },
    enabled: true,
  } as unknown as McpServer;
  mocks.list.mockReset().mockResolvedValue([server]);
  mocks.update.mockReset().mockResolvedValue(server);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(overlay("srv_2")));
    const save = await vi.waitFor(() => {
      const button = Array.from(host.querySelectorAll("button")).find(
        (item) => item.textContent === "Save",
      );
      expect(button).toBeDefined();
      return button;
    });
    const args = host.querySelector<HTMLInputElement>("#mcp-args");
    expect(args?.value).toBe("");
    expect(args?.placeholder).toBe("Stored encrypted");
    await act(async () => save?.click());
    expect(mocks.update).toHaveBeenCalledWith({
      id: "srv_2",
      config: expect.objectContaining({ args: [] }),
    });
  } finally {
    await act(async () => root.unmount());
  }
});

it("reopens with cached servers and refreshes them in the background", async () => {
  mocks.list.mockReset().mockResolvedValue([server("cached")]);
  const host = document.createElement("div");
  const first = createRoot(host);
  await act(async () => first.render(overlay()));
  await vi.waitFor(() => expect(host.textContent).toContain("cached"));
  await act(async () => first.unmount());
  await client.invalidateQueries();

  let finish: (servers: McpServer[]) => void = () => undefined;
  mocks.list.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const second = createRoot(host);
  try {
    await act(async () => second.render(overlay()));
    // Painted from the cache while the refresh is still out.
    expect(host.textContent).toContain("cached");
    expect(mocks.list).toHaveBeenCalledTimes(2);
    await act(async () => finish([server("cached"), server("added")]));
    await vi.waitFor(() => expect(host.textContent).toContain("added"));
  } finally {
    await act(async () => second.unmount());
  }
});

it("keeps a test result when an older list read lands after it", async () => {
  mocks.list.mockReset().mockResolvedValue([server("one")]);
  const host = document.createElement("div");
  const first = createRoot(host);
  await act(async () => first.render(overlay()));
  await act(async () => first.unmount());
  await client.invalidateQueries();

  let finishRead: (servers: McpServer[]) => void = () => undefined;
  mocks.list.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
  mocks.test.mockReset().mockResolvedValue(server("one", "ok"));
  const second = createRoot(host);
  try {
    await act(async () => second.render(overlay()));
    const testButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Test connection"),
    );
    await act(async () => testButton?.click());
    // The read started before the test and must not bring back its older health.
    await act(async () => finishRead([server("one")]));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    const cached = client
      .getQueryCache()
      .findAll({ predicate: (query) => JSON.stringify(query.queryKey).includes('"servers"') })
      .map((query) => query.state.data as McpServer[] | undefined);
    expect(cached[0]?.[0]?.health.status).toBe("ok");
  } finally {
    await act(async () => second.unmount());
  }
});

it.each([
  ["still loading", () => new Promise(() => undefined)],
  ["failed", () => Promise.reject(new Error("offline"))],
])("keeps agent access unchangeable while assignments are %s", async (state, read) => {
  mocks.list.mockReset().mockResolvedValue([server("docs")]);
  access.bots.mockResolvedValue([{ id: "bot_1", name: "Ada" }]);
  access.all.mockImplementation(read);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(overlay()));
    const agentButtons = () =>
      Array.from(host.querySelectorAll("button")).filter((button) => button.textContent === "Ada");
    // One in the add form and one on the server's card.
    await vi.waitFor(() => expect(agentButtons()).toHaveLength(2));
    for (const button of agentButtons()) {
      expect(button.disabled).toBe(true);
      await act(async () => button.click());
    }
    expect(access.replace).not.toHaveBeenCalled();
    if (state === "failed") {
      await vi.waitFor(() => expect(host.textContent).toContain("Could not load MCP servers"));
    }
  } finally {
    await act(async () => root.unmount());
  }
});

it("lets agent access change once assignments have loaded", async () => {
  mocks.list.mockReset().mockResolvedValue([server("docs")]);
  access.bots.mockResolvedValue([{ id: "bot_1", name: "Ada" }]);
  access.all.mockResolvedValue([
    { botId: "bot_1", serverId: "other", allowAllTools: true, allowedTools: [] },
  ]);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(overlay()));
    const cardButton = () =>
      Array.from(host.querySelectorAll("button")).filter(
        (button) => button.textContent === "Ada",
      )[1];
    await vi.waitFor(() => expect(cardButton()?.disabled).toBe(false));
    await act(async () => cardButton()!.click());
    // The bot keeps the assignment it already had.
    expect(access.replace).toHaveBeenCalledWith({
      botId: "bot_1",
      assignments: [
        { botId: "bot_1", serverId: "other", allowAllTools: true, allowedTools: [] },
        { serverId: "docs", allowAllTools: true, allowedTools: [] },
      ],
    });
  } finally {
    await act(async () => root.unmount());
  }
});

it("says when reopening could not refresh, while still showing the cached servers", async () => {
  mocks.list.mockReset().mockResolvedValue([server("cached")]);
  const host = document.createElement("div");
  const first = createRoot(host);
  await act(async () => first.render(overlay()));
  await vi.waitFor(() => expect(host.textContent).toContain("cached"));
  await act(async () => first.unmount());
  await client.invalidateQueries();

  mocks.list.mockRejectedValue(new Error("offline"));
  const second = createRoot(host);
  try {
    await act(async () => second.render(overlay()));
    await vi.waitFor(() => expect(host.textContent).toContain("Could not load MCP servers"));
    expect(host.textContent).toContain("cached");
  } finally {
    await act(async () => second.unmount());
  }
});
