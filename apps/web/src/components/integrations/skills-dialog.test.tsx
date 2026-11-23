// @vitest-environment jsdom
import type { CapabilityInstall, PluginMarketplaceCatalog } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  catalog: vi.fn(),
  installs: vi.fn(),
}));
const installsKey = ["installs"];

vi.mock("../../lib/query/query", () => {
  const queries = {
    marketplace: {
      catalog: {
        queryOptions: () => ({ queryKey: ["catalog"], queryFn: () => api.catalog() }),
      },
    },
    capabilities: {
      key: () => ["capabilities"],
      list: { queryOptions: () => ({ queryKey: installsKey, queryFn: () => api.installs() }) },
    },
    agentSkills: { key: () => ["agentSkills"] },
  };
  return { useSpaceQueries: () => queries };
});
vi.mock("../../pages/space/KnowledgeSection", () => ({
  AgentSkills: () => <p>Personal skill fixture</p>,
}));
vi.mock("../../lib/query/rpc", () => ({ rpc: {} }));
// One space, so no "Available in" choice appears.
vi.mock("./space-availability", () => ({
  AvailabilityControl: () => null,
  AvailabilityLabel: () => null,
  reachesOtherSpaces: () => false,
  useOwnSpaces: () => [],
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  useLinkFavicon: () => ({ icon: null, unusable: () => undefined }),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: parts }, ...values),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, other }: { value: number; other: string }) => other.replace("#", `${value}`),
}));
vi.mock("@rakazo/ui-web", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Passthrough,
    DialogClose: Passthrough,
    DialogContent: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
    Field: Passthrough,
    FieldLabel: Passthrough,
    SectionHeading: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    Spinner: () => <span role="status" />,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Input: ({ size: _size, ...props }: ComponentProps<"input"> & { size?: string }) => (
      <input {...props} />
    ),
  };
});

import { SkillsDialog } from "./skills-dialog";

function entry(id: string, displayName: string) {
  return {
    id,
    name: id,
    displayName,
    description: `${displayName} skills`,
    keywords: [],
    category: null,
    logo: null,
    homepage: null,
    domains: [],
    registry: "test",
    source: `https://github.com/example/${id}`,
    installedSource: `https://github.com/example/${id}`,
    hasConnector: false,
    skillCount: 3,
  };
}

const catalog: PluginMarketplaceCatalog = {
  entries: [entry("notes", "Notes"), entry("calendar", "Calendar")],
  unavailableRegistries: [],
  skippedEntries: 0,
};
const NO_INSTALLS = [] as CapabilityInstall[];
const install: CapabilityInstall = {
  id: "installed-notes",
  kind: "plugin",
  name: "Notes",
  source: entry("notes", "Notes").source,
  version: null,
  digest: null,
  secretConfigured: false,
  createdAt: "2026-01-01T00:00:00Z",
  config: {
    format: "agent-plugins",
    name: "Notes",
    version: null,
    description: "A fixture pack",
    author: null,
    homepage: null,
    repository: null,
    license: null,
    keywords: [],
    resolvedSha: "a".repeat(40),
    digest: `sha256:${"b".repeat(64)}`,
    parts: ["skills"],
    skills: [{ name: "write-note", description: "A fixture skill" }],
    mcpServers: [],
    skipped: [],
  },
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

function searchInput() {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search skills"]');
  if (!input) throw new Error("Missing search input");
  return input;
}

function type(text: string) {
  const input = searchInput();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SkillsDialog onClose={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
}

const noMatchLine = "No skills match your search.";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.installs.mockResolvedValue(NO_INSTALLS);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("SkillsDialog browse search", () => {
  it("says no skills match when a search finds no skill pack", async () => {
    api.catalog.mockResolvedValue(catalog);
    await render();
    await vi.waitUntil(() => container.querySelectorAll('[data-testid="skill-packs"] > *').length);

    type("zzzz");

    await vi.waitFor(() => expect(container.textContent).toContain(noMatchLine));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(noMatchLine);
    expect(container.querySelectorAll('[data-testid="skill-packs"] > *')).toHaveLength(0);
  });

  it("shows the matching pack and not the no-match line", async () => {
    api.catalog.mockResolvedValue(catalog);
    await render();
    await vi.waitUntil(() => container.querySelectorAll('[data-testid="skill-packs"] > *').length);

    type("calendar");

    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-testid="skill-packs"] > *')).toHaveLength(1),
    );
    expect(container.querySelector('[data-testid="skill-packs"]')?.textContent).toContain(
      "Calendar",
    );
    expect(container.textContent).not.toContain(noMatchLine);
  });

  it("does not claim no match when a registry could not load", async () => {
    api.catalog.mockResolvedValue({ ...catalog, unavailableRegistries: ["test"] });
    await render();
    await vi.waitUntil(() => container.querySelector('[role="alert"]'));
    type("zzzz");
    expect(container.textContent).not.toContain(noMatchLine);
  });

  it("shows no line while the catalog is still loading", async () => {
    const pending = deferred<PluginMarketplaceCatalog>();
    api.catalog.mockReturnValue(pending.promise);
    await render();

    type("zzzz");

    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.textContent).not.toContain(noMatchLine);
    await act(async () => pending.resolve(catalog));
    await vi.waitFor(() => expect(container.textContent).toContain(noMatchLine));
  });
});

it("lists skill packs without connectors", async () => {
  api.catalog.mockResolvedValue({
    ...catalog,
    entries: [
      entry("notes", "Notes"),
      entry("travel", "Travel"),
      { ...entry("mail", "Mail"), hasConnector: true },
    ],
  });
  await render();
  const packs = await vi.waitUntil(() =>
    container.querySelector('[data-testid="skill-packs"]')?.children.length
      ? container.querySelector<HTMLElement>('[data-testid="skill-packs"]')
      : null,
  );
  expect([...packs.children].map((row) => row.textContent)).toEqual([
    expect.stringContaining("Notes"),
    expect.stringContaining("Travel"),
  ]);
});

function alert(message: string) {
  return [...container.querySelectorAll('[role="alert"]')].find((row) =>
    row.textContent?.includes(message),
  );
}

function browse() {
  return container.querySelector('[data-testid="skill-packs"]');
}

const installedLoadError = "Could not load installed skill packs.";

describe("SkillsDialog installed packs", () => {
  it("retries the first installed pack read without touching the healthy catalogue", async () => {
    const retry = deferred<CapabilityInstall[]>();
    api.catalog.mockResolvedValue(catalog);
    api.installs.mockRejectedValueOnce(new Error("offline")).mockReturnValue(retry.promise);
    await render();

    const notice = await vi.waitUntil(() => alert(installedLoadError));
    expect(container.textContent).toContain("Personal skill fixture");
    expect(browse()?.textContent).toContain("Notes");
    expect(notice.querySelector("button")?.textContent).toBe("Retry");
    await act(async () => notice.querySelector("button")?.click());
    await vi.waitFor(() => expect(alert(installedLoadError)).toBeUndefined());
    expect(api.installs).toHaveBeenCalledTimes(2);
    expect(api.catalog).toHaveBeenCalledOnce();

    await act(async () => retry.resolve([install]));
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="plugin-skill-set"]')?.textContent).toContain(
        "Notes",
      ),
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(browse()?.textContent).toContain("Added");
  });

  it("preserves the successful empty installed list and existing Browse results", async () => {
    api.catalog.mockResolvedValue(catalog);
    await render();
    await vi.waitFor(() => expect(browse()?.textContent).toContain("Notes"));

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-testid="plugin-skill-sets"]')).toBeNull();
    expect(browse()?.textContent).not.toContain("Added");
  });

  it("leaves cached installed pack rows visible after a later refresh failure", async () => {
    api.catalog.mockResolvedValue(catalog);
    api.installs.mockResolvedValueOnce([install]).mockRejectedValue(new Error("offline"));
    await render();
    await vi.waitFor(() => expect(browse()?.textContent).toContain("Added"));
    await act(async () => client.invalidateQueries({ queryKey: installsKey }));

    expect(client.getQueryState(installsKey)?.status).toBe("error");
    expect(api.installs).toHaveBeenCalledTimes(2);
    expect(alert(installedLoadError)).toBeUndefined();
    expect(container.querySelector('[data-testid="plugin-skill-set"]')).not.toBeNull();
    expect(browse()?.textContent).toContain("Added");
  });

  it("leaves a catalogue-only retry independent of installed packs", async () => {
    api.catalog.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(catalog);
    await render();
    const notice = await vi.waitUntil(() => alert("Some plugins could not be loaded."));
    expect(alert(installedLoadError)).toBeUndefined();
    expect(notice.querySelector("button")?.textContent).toBe("Retry");
    await act(async () => notice.querySelector("button")?.click());
    await vi.waitFor(() => expect(browse()?.textContent).toContain("Notes"));

    expect(api.installs).toHaveBeenCalledOnce();
    expect(api.catalog).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
