// @vitest-environment jsdom

import type { CapabilityInstall, PluginMarketplaceCatalog } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SkillsDialog } from "./skills-dialog";

const reads = vi.hoisted(() => ({ catalog: vi.fn(), installs: vi.fn() }));
const installsKey = ["skills-fixture", "installs"];
vi.mock("../../lib/query/query", () => ({
  useSpaceQueries: () => ({
    marketplace: {
      catalog: {
        queryOptions: () => ({ queryKey: ["skills-fixture", "catalog"], queryFn: reads.catalog }),
      },
    },
    capabilities: {
      list: { queryOptions: () => ({ queryKey: installsKey, queryFn: reads.installs }) },
    },
  }),
}));
vi.mock("../../pages/space/KnowledgeSection", () => ({
  AgentSkills: () => <p>Personal skill fixture</p>,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  useLinkFavicon: () => ({ icon: null, unusable: () => undefined }),
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & {
      variant?: string;
      size?: string;
    }) => <button {...props} />,
    Dialog: Container,
    DialogClose: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    Field: Container,
    FieldLabel: Container,
    Input: ({
      size: _size,
      ...props
    }: Omit<ComponentProps<"input">, "size"> & { size?: string }) => <input {...props} />,
    SectionHeading: Container,
    Spinner: (props: ComponentProps<"span">) => <span {...props} />,
  };
});

const source = "https://example.test/fixture/notes";
const catalog: PluginMarketplaceCatalog = {
  skippedEntries: 0,
  unavailableRegistries: [],
  entries: [
    {
      id: "notes",
      name: "notes",
      displayName: "Notes pack",
      description: "A fixture pack",
      keywords: [],
      category: null,
      logo: null,
      homepage: null,
      domains: [],
      registry: "fixture",
      source,
      installedSource: source,
      hasConnector: false,
      skillCount: 1,
    },
  ],
};
const install: CapabilityInstall = {
  id: "installed-notes",
  kind: "plugin",
  name: "Notes pack",
  source,
  version: null,
  digest: null,
  secretConfigured: false,
  createdAt: "2026-01-01T00:00:00Z",
  config: {
    format: "agent-plugins",
    name: "Notes pack",
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

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler((callback) => callback());
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  reads.catalog.mockResolvedValue(catalog);
  reads.installs.mockResolvedValue([]);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SkillsDialog onClose={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  await act(flush);
}
function alert(message: string) {
  return [...host.querySelectorAll('[role="alert"]')].find((row) =>
    row.textContent?.includes(message),
  );
}
function browse() {
  return host.querySelector('[data-testid="skill-packs"]');
}

it("retries the first installed pack read without touching the healthy catalogue", async () => {
  const retry = deferred<CapabilityInstall[]>();
  reads.installs.mockRejectedValueOnce(new Error("offline")).mockReturnValue(retry.promise);
  await render();

  expect(host.textContent).toContain("Personal skill fixture");
  expect(browse()?.textContent).toContain("Notes pack");
  const notice = alert("Could not load installed skill packs.");
  expect(notice?.querySelector("button")?.textContent).toBe("Retry");
  await act(async () => notice?.querySelector("button")?.click());
  await act(flush);
  expect(reads.installs).toHaveBeenCalledTimes(2);
  expect(reads.catalog).toHaveBeenCalledOnce();
  expect(alert("Could not load installed skill packs.")).toBeUndefined();

  await act(async () => retry.resolve([install]));
  await act(flush);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[data-testid="plugin-skill-set"]')?.textContent).toContain(
    "Notes pack",
  );
  expect(browse()?.textContent).toContain("Added");
});

it("preserves the successful empty installed list and existing Browse results", async () => {
  await render();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[data-testid="plugin-skill-sets"]')).toBeNull();
  expect(browse()?.textContent).toContain("Notes pack");
  expect(browse()?.textContent).not.toContain("Added");
});

it("leaves cached installed pack rows visible after a later refresh failure", async () => {
  reads.installs.mockResolvedValueOnce([install]).mockRejectedValue(new Error("offline"));
  await render();
  await act(async () => client.invalidateQueries({ queryKey: installsKey }));
  await act(flush);

  expect(reads.installs).toHaveBeenCalledTimes(2);
  expect(alert("Could not load installed skill packs.")).toBeUndefined();
  expect(host.querySelector('[data-testid="plugin-skill-set"]')).not.toBeNull();
  expect(browse()?.textContent).toContain("Added");
});

it("leaves a catalogue-only retry independent of installed packs", async () => {
  reads.catalog.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(catalog);
  await render();
  expect(alert("Could not load installed skill packs.")).toBeUndefined();
  const retry = alert("Some plugins could not be loaded.")?.querySelector("button");
  expect(retry?.textContent).toBe("Retry");
  await act(async () => retry?.click());
  await act(flush);

  expect(reads.installs).toHaveBeenCalledOnce();
  expect(reads.catalog).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
