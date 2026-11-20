// @vitest-environment jsdom
import type { Bot, MarketplaceBotCatalogEntry } from "@rakazo/contracts";
import { MarketplaceBotSchema } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  catalog: vi.fn(),
  get: vi.fn(),
  appCatalog: vi.fn(),
  install: vi.fn(),
  getBot: vi.fn(),
}));

vi.mock("../../lib/query/rpc", () => ({
  rpc: {
    botMarketplace: { install: api.install },
    bots: { get: api.getBot },
  },
}));
vi.mock("../../lib/query/query", () => ({
  useSpaceQueries: () => ({
    botMarketplace: {
      catalog: {
        queryOptions: () => ({ queryKey: ["market-catalog"], queryFn: () => api.catalog() }),
      },
      get: {
        queryOptions: ({ input }: { input: { slug: string } }) => ({
          queryKey: ["market-get", input.slug],
          queryFn: () => api.get(input),
        }),
      },
    },
    connections: {
      catalog: {
        queryOptions: () => ({ queryKey: ["conn-catalog"], queryFn: () => api.appCatalog() }),
      },
    },
  }),
}));
vi.mock("../../lib/query/user-error", () => ({
  errorDetails: (error: unknown, fallback: string) => ({
    message: error instanceof Error ? error.message : fallback,
  }),
}));
vi.mock("../ErrorNotice", () => ({
  ErrorNotice: ({ error }: { error: { message: string } }) => (
    <div role="alert">{error.message}</div>
  ),
}));
vi.mock("../integrations/plugin-marketplace", () => ({ ROW_HOVER: "" }));
vi.mock("./bot-marketplace-detail", () => ({
  BotMarketplaceDetail: ({
    listing,
    botId,
    onAdd,
    onOpen,
  }: {
    listing: { name: string };
    botId?: string | null;
    onAdd?: () => void;
    onOpen?: () => void;
  }) => (
    <div data-testid="market-detail">
      <span>{listing.name}</span>
      {botId ? (
        <button type="button" onClick={onOpen}>
          Open my bot
        </button>
      ) : (
        <button type="button" onClick={onAdd}>
          Add bot
        </button>
      )}
    </div>
  ),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogClose: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    ListSearchInput: ({
      query,
      setQuery,
      label,
    }: {
      query: string;
      setQuery: (value: string) => void;
      label: string;
    }) => (
      <input aria-label={label} value={query} onChange={(event) => setQuery(event.target.value)} />
    ),
    SectionHeading: Pass,
    Spinner: () => <span role="status" />,
  };
});

import { BotMarketplaceDialog } from "./bot-marketplace-dialog";

const entry = (overrides: Partial<MarketplaceBotCatalogEntry>): MarketplaceBotCatalogEntry => ({
  slug: "morning-briefing",
  name: "Morning briefing",
  tagline: "Your weekday overview.",
  category: "personal",
  version: 1,
  featured: true,
  sortOrder: 0,
  author: { name: "Rakazo Team" },
  apps: ["gmail"],
  botId: null,
  ...overrides,
});

const listing = MarketplaceBotSchema.parse({
  id: "morning-briefing",
  version: 1,
  name: "Morning briefing",
  summary: "A weekday morning overview.",
  sample: "**Today**\n- 10:00 design review",
  description: "A scannable briefing.",
  instructions: "Summarise the day.",
  skills: [],
  routines: [],
  apps: ["gmail"],
  author: { name: "Rakazo Team" },
  license: "Apache-2.0",
  category: "personal",
  tagline: "Your weekday overview.",
  outcomes: ["A morning briefing."],
});

const bot = { id: "bot-1", name: "Morning briefing" } as Bot;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let opened: Bot[];

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  opened = [];
  api.catalog.mockReset().mockResolvedValue({
    entries: [
      entry({}),
      entry({
        slug: "pr-reviewer",
        name: "PR reviewer",
        tagline: "Reviews your PRs.",
        category: "engineering",
        featured: false,
        sortOrder: 1,
        apps: [],
      }),
    ],
  });
  api.get.mockReset().mockResolvedValue({ listing, botId: null });
  api.appCatalog.mockReset().mockResolvedValue([{ slug: "gmail", name: "Gmail" }]);
  api.install.mockReset().mockResolvedValue({ bot, created: true });
  api.getBot.mockReset().mockResolvedValue(bot);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <BotMarketplaceDialog onClose={() => undefined} onOpenBot={(b) => opened.push(b)} />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => {
    if (!container.querySelector('[data-testid="market-row"]')) throw new Error("Loading");
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(name: string, scope: ParentNode = container) {
  const found = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

it("shows featured and category rows, and filters by search and category", async () => {
  expect(container.querySelectorAll('[data-testid="market-featured-card"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-testid="market-row"]')).toHaveLength(2);

  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search bots"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(search, "nothing");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelectorAll('[data-testid="market-row"]')).toHaveLength(0);
  expect(container.querySelector('[data-testid="market-featured-card"]')).toBeNull();

  await click(button("Clear filters"));
  expect(container.querySelectorAll('[data-testid="market-row"]')).toHaveLength(2);

  await click(button("Engineering"));
  expect(container.querySelectorAll('[data-testid="market-row"]')).toHaveLength(1);
  expect(container.textContent).toContain("PR reviewer");
});

it("opens the detail and installs the bot into the chat", async () => {
  await click(container.querySelector('[data-testid="market-row"]')!);
  await vi.waitFor(() => {
    if (!container.querySelector('[data-testid="market-detail"]')) throw new Error("Loading");
  });
  await click(button("Add bot"));
  expect(api.install).toHaveBeenCalledWith({ slug: "morning-briefing", version: 1 });
  await vi.waitFor(() => {
    if (opened.length === 0) throw new Error("Waiting for the bot");
  });
  expect(opened[0]!.id).toBe("bot-1");
});

it("opens the existing bot from an added row", async () => {
  api.catalog.mockResolvedValue({ entries: [entry({ botId: "bot-1" })] });
  await act(async () => root.unmount());
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <BotMarketplaceDialog onClose={() => undefined} onOpenBot={(b) => opened.push(b)} />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => {
    if (!container.querySelector('[data-testid="market-row"]')) throw new Error("Loading");
  });
  await click(button("Added"));
  expect(api.getBot).toHaveBeenCalledWith({ botId: "bot-1" });
  await vi.waitFor(() => {
    if (opened.length === 0) throw new Error("Waiting for the bot");
  });
  expect(opened[0]!.id).toBe("bot-1");
});
