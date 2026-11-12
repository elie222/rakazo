// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectMcpOauth } from "../lib/mcp-connect";
import { PluginsOverlay } from "./PluginsOverlay";

const api = vi.hoisted(() => ({
  connections: {
    catalog: vi.fn(),
    list: vi.fn(),
    tools: vi.fn(),
  },
  capabilities: {
    list: vi.fn(),
    catalogSearch: vi.fn(),
    sourcePresets: vi.fn(),
    pluginPreview: vi.fn(),
    install: vi.fn(),
  },
  mcp: {
    apps: { connect: vi.fn() },
    servers: { list: vi.fn() },
    assignments: { list: vi.fn(), approve: vi.fn() },
  },
  marketplace: { catalog: vi.fn() },
}));

vi.mock("../lib/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("../lib/mcp-connect", () => ({ connectMcpOauth: vi.fn() }));
vi.mock("../components/integrations/space-availability", () => ({
  AvailabilityControl: () => null,
  AvailabilityLabel: () => null,
  reachesOtherSpaces: () => false,
  useOwnSpaces: () => [],
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
  const container = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return Object.fromEntries([
    ...[
      "Badge",
      "Dialog",
      "DialogClose",
      "DialogContent",
      "DialogHeader",
      "DialogTitle",
      "Disclosure",
      "DropdownMenu",
      "DropdownMenuContent",
      "DropdownMenuItem",
      "DropdownMenuSeparator",
      "DropdownMenuTrigger",
      "Field",
      "FieldDescription",
      "FieldLabel",
      "NativeSelect",
      "NativeSelectOption",
      "SectionHeading",
      "Spinner",
    ].map((name) => [name, container]),
    [
      "Button",
      ({
        children,
        onClick,
        disabled,
        type,
        "aria-label": label,
      }: {
        children?: ReactNode;
        onClick?: () => void;
        disabled?: boolean;
        type?: "button" | "submit";
        "aria-label"?: string;
      }) =>
        createElement(
          "button",
          { type: type ?? "button", onClick, disabled, "aria-label": label },
          children,
        ),
    ],
    [
      "Input",
      (props: {
        value?: string;
        disabled?: boolean;
        placeholder?: string;
        onChange?: () => void;
        "aria-label"?: string;
      }) =>
        createElement("input", {
          value: props.value,
          disabled: props.disabled,
          placeholder: props.placeholder,
          onChange: props.onChange,
          "aria-label": props["aria-label"],
        }),
    ],
  ]);
});

let client: QueryClient;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.connections.catalog.mockReset().mockResolvedValue([]);
  api.connections.list.mockReset().mockResolvedValue([]);
  api.connections.tools.mockReset().mockResolvedValue([]);
  api.capabilities.list.mockReset().mockResolvedValue([]);
  api.capabilities.sourcePresets.mockReset().mockResolvedValue([]);
  api.capabilities.catalogSearch
    .mockReset()
    .mockImplementation(async (input: { usePublicCatalog?: boolean }) =>
      input.usePublicCatalog
        ? {
            enabled: true,
            results: [
              {
                domain: "canva.example.test",
                name: "Canva",
                description: "",
                pageUrl: null,
                surfaces: [
                  {
                    kind: "mcp",
                    slug: "canva",
                    source: "https://mcp.canva.example.test/mcp",
                    auth: null,
                  },
                ],
              },
            ],
          }
        : { enabled: false, results: [] },
    );
  api.mcp.apps.connect.mockReset().mockResolvedValue({ serverId: "server-1" });
  api.mcp.assignments.approve.mockReset().mockResolvedValue({});
  vi.mocked(connectMcpOauth).mockReset().mockResolvedValue("connected");
  api.mcp.servers.list.mockReset().mockResolvedValue([]);
  api.mcp.assignments.list.mockReset().mockResolvedValue([]);
  api.marketplace.catalog.mockReset().mockResolvedValue({ entries: [], unavailableRegistries: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function searchBox() {
  return host.querySelector<HTMLInputElement>('input[aria-label="Search apps"]')!;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function publicCatalogRow() {
  return Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.startsWith("Search MCP servers for"),
  );
}

function publicSearches() {
  return api.capabilities.catalogSearch.mock.calls.filter(
    (call) => (call[0] as { usePublicCatalog?: boolean }).usePublicCatalog,
  );
}

it("offers the public catalog for a search and sends nothing there until it is picked", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));

  await type(searchBox(), "c");
  expect(publicCatalogRow()).toBeUndefined();

  // Longer than the catalog search accepts: nothing to offer.
  await type(searchBox(), "x".repeat(254));
  expect(publicCatalogRow()).toBeUndefined();

  await type(searchBox(), " canva ");
  expect(host.textContent).toContain("No apps match your search.");
  expect(publicCatalogRow()?.textContent).toBe("Search MCP servers for “canva”");
  expect(publicSearches()).toHaveLength(0);

  await act(async () => publicCatalogRow()?.click());
  await vi.waitFor(() => expect(host.textContent).toContain("Canva"));
  expect(host.textContent).toContain("Add MCP server");
  expect(searchBox().value).toBe("canva");
  expect(publicSearches()).toEqual([[{ query: "canva", usePublicCatalog: true }]]);
});

it("connects an operator-provided app through personal OAuth and assigns only the active bot", async () => {
  api.connections.catalog.mockResolvedValue([
    {
      connectorId: "deployment",
      slug: "files",
      name: "Files",
      logo: null,
      connected: false,
      noAuth: false,
      mcpAppId: "files",
    },
  ]);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} activeBotId="bot-1" />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  await type(searchBox(), "Files");
  const add = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Connect",
  )!;
  expect(add.getAttribute("aria-label")).toBe("Connect Files");
  await act(async () => add.click());
  await vi.waitFor(() => expect(connectMcpOauth).toHaveBeenCalledWith("server-1"));
  expect(api.mcp.apps.connect).toHaveBeenCalledWith({ appId: "files", botId: "bot-1" });
  expect(api.mcp.assignments.approve).not.toHaveBeenCalled();
});

it("keeps management available for a connected app after operator setup is removed", async () => {
  api.connections.catalog.mockResolvedValue([
    {
      connectorId: "deployment",
      slug: "files",
      name: "Files",
      logo: null,
      connected: true,
      noAuth: false,
      mcpAppId: "files",
      mcpServerId: "server-1",
      needsSetup: true,
    },
  ]);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  await type(searchBox(), "Files");
  expect(host.textContent).not.toContain("Server setup required");
  expect(
    Array.from(host.querySelectorAll("button")).some((button) => button.textContent === "Added"),
  ).toBe(true);
});

it("opens a bundled app's matching plugin skills while keeping its connection separate", async () => {
  const source = "https://github.com/example/files";
  api.connections.catalog.mockResolvedValue([
    {
      connectorId: "deployment",
      slug: "files",
      name: "Files",
      logo: null,
      connected: false,
      noAuth: false,
      mcpAppId: "files",
    },
  ]);
  api.marketplace.catalog.mockResolvedValue({
    entries: [
      {
        id: "files",
        name: "files",
        displayName: "Files",
        description: "",
        keywords: [],
        category: "productivity",
        logo: null,
        homepage: null,
        domains: [],
        registry: "Example",
        source,
        installedSource: source,
        hasConnector: true,
        skillCount: 1,
      },
    ],
    unavailableRegistries: [],
  });
  api.capabilities.pluginPreview.mockResolvedValue({
    format: "agent-plugins",
    name: "files",
    version: null,
    description: "",
    author: null,
    homepage: null,
    repository: null,
    license: null,
    keywords: [],
    resolvedSha: "a".repeat(40),
    pinnedSource: source,
    digest: `sha256:${"b".repeat(64)}`,
    skills: [{ name: "file-notes", description: "Write notes" }],
    mcpServers: [
      {
        name: "files-mcp",
        transport: "streamable_http",
        endpoint: "https://files.example.test/mcp",
        staticHeaderKeys: [],
      },
    ],
    skipped: [],
  });
  const openMcp = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} onOpenMcp={openMcp} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  await type(searchBox(), "Files");
  const title = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.endsWith("Files"),
  )!;
  await act(async () => title.click());
  await vi.waitFor(() => expect(host.textContent).toContain("file-notes"));
  expect(openMcp).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("files-mcp");
  expect(
    Array.from(host.querySelectorAll("button")).some((button) => button.textContent === "Connect"),
  ).toBe(false);
  expect(
    Array.from(host.querySelectorAll("button")).some((button) => button.textContent === "Add"),
  ).toBe(true);
});
