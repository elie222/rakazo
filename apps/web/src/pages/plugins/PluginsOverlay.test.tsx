// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { deferred, flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { act, cloneElement } from "react";
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
      "DialogContent",
      "DialogHeader",
      "DialogTitle",
      "Disclosure",
      "DropdownMenu",
      "DropdownMenuContent",
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
      "DropdownMenuItem",
      ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) =>
        createElement("div", { role: "menuitem", onClick }, children),
    ],
    [
      "DialogClose",
      ({ children, render }: { children?: ReactNode; render: ReactElement }) =>
        cloneElement(render, undefined, children),
    ],
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
  // The plugin catalog text both apps share is translated at run time, so it needs a locale.
  i18n.load("en", {});
  i18n.activate("en");
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
    button.textContent?.startsWith("Search public MCP directory for"),
  );
}

function publicSearches() {
  return api.capabilities.catalogSearch.mock.calls
    .map(([input]) => input as { usePublicCatalog?: boolean })
    .filter((input) => input.usePublicCatalog);
}

it("shows public catalog results inline and sends nothing there until asked", async () => {
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
  expect(host.textContent).toContain("No matches in your current catalogs.");
  expect(publicCatalogRow()?.textContent).toBe("Search public MCP directory for “canva”");
  expect(publicSearches()).toHaveLength(0);

  await act(async () => publicCatalogRow()?.click());
  await vi.waitFor(() => expect(host.textContent).toContain("Canva"));
  expect(host.textContent).not.toContain("No matches in your current catalogs.");
  expect(searchBox().value).toBe(" canva ");
  expect(publicSearches()).toEqual([{ query: "canva", usePublicCatalog: true }]);

  const add = host.querySelector<HTMLButtonElement>('button[aria-label="Add Canva"]');
  expect(add).not.toBeNull();
  await act(async () => add?.click());
  expect(host.textContent).toContain("Verify and add");
  expect(host.textContent).not.toContain("Save and sign in");
});

it("shows progress while retrying a failed public directory search", async () => {
  const retry = deferred<{ enabled: true; results: [] }>();
  let searches = 0;
  api.capabilities.catalogSearch.mockImplementation(async ({ usePublicCatalog }) => {
    if (!usePublicCatalog) return { enabled: false, results: [] };
    if (++searches === 1) throw new Error("Lookup failed");
    return retry.promise;
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  await type(searchBox(), "tracker");
  await act(async () => publicCatalogRow()?.click());
  await vi.waitFor(() => expect(host.textContent).toContain("Could not load MCP servers."));

  await act(async () => publicCatalogRow()?.click());
  await act(flush);
  const searching = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Searching…",
  );
  expect(searching?.disabled).toBe(true);
  expect(host.textContent).not.toContain("Could not load MCP servers.");

  await act(async () => retry.resolve({ enabled: true, results: [] }));
  await vi.waitFor(() => expect(host.textContent).toContain("No apps match your search."));
});

it("opens Manage for an already-added direct MCP source", async () => {
  const managedCatalog = deferred<[]>();
  api.connections.catalog.mockReturnValue(managedCatalog.promise);
  const url = "https://mcp.tracker.example.test/mcp";
  api.capabilities.sourcePresets.mockResolvedValue([
    { id: "tracker", name: "Tracker", url, featured: true },
  ]);
  api.capabilities.list.mockResolvedValue([
    { id: "tracker-source", kind: "mcp", source: url, name: "Tracker" },
  ]);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await act(flush);
  expect(api.capabilities.sourcePresets).toHaveBeenCalled();
  expect(host.querySelector('button[aria-label="Add Tracker"]')).toBeNull();

  await act(async () => managedCatalog.resolve([]));
  const added = () => host.querySelector<HTMLButtonElement>('button[aria-label="Added: Tracker"]');
  await vi.waitFor(() => expect(added()).not.toBeNull());
  await act(async () => added()?.click());
  expect(host.querySelector('[data-testid="integrations-source-form"]')).toBeNull();
  expect(host.textContent).toContain("Remove");
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

it("keeps Close outside the wrapping action group so narrow screens still reach it", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} onOpenTemplates={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  const close = host.querySelector('button[aria-label="Close integrations"]');
  expect(close).not.toBeNull();
  const templates = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Templates"),
  )!;
  expect(templates.parentElement!.contains(close!)).toBe(false);
  expect(close!.compareDocumentPosition(templates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("leaves no empty action row above a form that has no header actions", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));
  const github = [...host.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === "From GitHub",
  )!;
  await act(async () => (github as HTMLElement).click());
  const close = host.querySelector('button[aria-label="Close integrations"]')!;
  expect(close.parentElement!.querySelector(":scope > div:empty")).toBeNull();
  expect(host.querySelector('button[aria-label="Add custom"]')).toBeNull();
});
