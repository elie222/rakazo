// @vitest-environment jsdom
import type { PluginMarketplaceEntry } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SkillsDialog } from "./skills-dialog";

const api = vi.hoisted(() => ({ catalog: vi.fn(), installs: vi.fn() }));

vi.mock("../../lib/query/query", () => ({
  useSpaceQueries: () => ({
    marketplace: {
      catalog: {
        queryOptions: () => ({ queryKey: ["catalog"], queryFn: () => api.catalog() }),
      },
    },
    capabilities: {
      list: {
        key: () => ["installs"],
        queryOptions: () => ({ queryKey: ["installs"], queryFn: () => api.installs() }),
      },
    },
    agentSkills: { key: () => ["agent-skills"] },
  }),
}));
vi.mock("../../pages/space/KnowledgeSection", () => ({ AgentSkills: () => null }));
vi.mock("@rakazo/chat-ui/web", () => ({
  useLinkFavicon: () => ({ icon: null, unusable: () => undefined }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, other }: { value: number; other: string }) => other.replace("#", `${value}`),
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: parts }, ...values),
  }),
}));

function pack(id: string, displayName: string): PluginMarketplaceEntry {
  const source = `https://github.com/example/${id}`;
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
    registry: "example",
    source,
    installedSource: source,
    hasConnector: false,
    skillCount: 1,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("lists the skill packs without connectors in a single column on phones", async () => {
  api.catalog.mockResolvedValue({
    entries: [
      pack("notes", "Notes"),
      pack("travel", "Travel"),
      { ...pack("mail", "Mail"), hasConnector: true },
    ],
    unavailableRegistries: [],
  });
  api.installs.mockResolvedValue([]);
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SkillsDialog onClose={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  const packs = await vi.waitUntil(() =>
    document.querySelector('[data-testid="skill-packs"]')?.children.length
      ? document.querySelector<HTMLElement>('[data-testid="skill-packs"]')
      : null,
  );

  expect([...packs.children].map((row) => row.textContent)).toEqual([
    expect.stringContaining("Notes"),
    expect.stringContaining("Travel"),
  ]);
  expect(packs.className).toContain("grid-cols-1");
  expect(packs.className).toContain("sm:grid-cols-2");
});
