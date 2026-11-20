// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginsOverlay } from "./PluginsOverlay";
import { SourceFormView, useSourceForm } from "./source-form";

const api = vi.hoisted(() => ({
  connections: {
    catalog: vi.fn(),
    list: vi.fn(),
    tools: vi.fn(),
  },
  capabilities: { list: vi.fn(), catalogSearch: vi.fn(), sourcePresets: vi.fn() },
  mcp: { servers: { list: vi.fn() }, assignments: { list: vi.fn() } },
  marketplace: { catalog: vi.fn() },
}));

vi.mock("../../lib/query/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("../../lib/integrations/mcp-connect", () => ({ connectMcpOauth: vi.fn() }));
vi.mock("../../components/integrations/space-availability", () => ({
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
      "OptionSelect",
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
  expect(host.querySelector('[role="status"]')?.textContent).toBe("No apps match your search.");
  expect(publicCatalogRow()?.textContent).toBe("Search MCP servers for “canva”");
  expect(publicSearches()).toHaveLength(0);

  await act(async () => publicCatalogRow()?.click());
  await vi.waitFor(() => expect(host.textContent).toContain("Canva"));
  expect(host.textContent).toContain("Add MCP server");
  expect(searchBox().value).toBe("canva");
  expect(publicSearches()).toEqual([[{ query: "canva", usePublicCatalog: true }]]);
});

it("keeps complete Unicode initials in the connected-app marks", async () => {
  api.connections.catalog.mockResolvedValue(
    ["🦞 OpenClaw", "𠮷野", "notes"].map((name, i) => ({
      connectorId: "fixture",
      slug: `app-${i}`,
      name,
      logo: null,
      connected: true,
      noAuth: false,
    })),
  );
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  const marks = [...host.querySelectorAll("span[aria-hidden] .place-items-center")].map(
    (mark) => mark.textContent,
  );
  expect(marks).toEqual(["🦞", "𠮷", "N"]);
});

it("opens both Unicode fallback screenshot targets through browse and manage", async () => {
  api.connections.catalog.mockResolvedValue([
    {
      connectorId: "fixture",
      slug: "unicode",
      name: "𠮷野",
      logo: null,
      connected: true,
      noAuth: false,
    },
  ]);
  api.marketplace.catalog.mockResolvedValue({
    entries: [
      {
        id: "openclaw",
        name: "openclaw",
        displayName: "🦞 OpenClaw",
        description: "Fixture integration",
        keywords: [],
        category: "productivity",
        logo: null,
        homepage: null,
        domains: [],
        registry: "fixture",
        source: "https://example.test/plugin",
        installedSource: "https://example.test/plugin",
        hasConnector: true,
        skillCount: 0,
      },
    ],
    unavailableRegistries: [],
    skippedEntries: 0,
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  expect(
    [...host.querySelectorAll(".place-items-center")].some((el) => el.textContent === "🦞"),
  ).toBe(true);
  const connected = host.querySelector("span[aria-hidden]")!.closest("button")!;
  await act(async () => connected.click());
  const apps = host.querySelector('[data-testid="connected-apps"]')!;
  expect(
    [...apps.querySelectorAll(".place-items-center")].some((el) => el.textContent === "𠮷"),
  ).toBe(true);
  const added = [...apps.querySelectorAll("button")].find(
    (button) => button.textContent === "Added",
  )!;
  await act(async () => added.click());
  expect(
    host.querySelector('[data-testid="connection-detail"] .place-items-center')?.textContent,
  ).toBe("𠮷");
});

it("opens a sign-in preset with its address filled in and no token to paste", async () => {
  const preset = {
    id: "gateway",
    name: "Gateway",
    defaultUrl: "https://gateway.example.test/mcp",
    signIn: true,
  };
  let form: ReturnType<typeof useSourceForm> | null = null;
  function Harness() {
    form = useSourceForm();
    return (
      <SourceFormView
        form={form}
        installing={false}
        sourceError={null}
        onBack={() => {}}
        onSubmit={() => {}}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  await act(async () => form?.start("mcp", preset));

  // Name and address only: a token preset would add a third field for the token.
  expect([...host.querySelectorAll("input")].map((input) => input.value)).toEqual([
    "Gateway",
    "https://gateway.example.test/mcp",
  ]);
  expect(host.textContent).toContain("Save and sign in");
});

it("leads from an app that is also a chat app here to messaging, and says nothing for other apps", async () => {
  api.connections.catalog.mockResolvedValue(
    [
      { slug: "chatty", name: "Chatty", chatApp: true },
      { slug: "notes", name: "Notes" },
    ].map((app) => ({
      connectorId: "fixture",
      logo: null,
      connected: false,
      noAuth: false,
      ...app,
    })),
  );
  const onOpenMessaging = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} onOpenMessaging={onOpenMessaging} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(host.textContent).toContain("Notes"));

  const hints = host.querySelectorAll('[data-testid="chat-app-hint"]');
  expect([...hints].map((hint) => hint.textContent)).toEqual([
    "Tools for your bot.Chat from Chatty",
  ]);
  await act(async () => hints[0]!.querySelector("button")!.click());
  expect(onOpenMessaging).toHaveBeenCalledOnce();
});
