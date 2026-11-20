// @vitest-environment jsdom
import type { MarketplaceBotAdminRow } from "@rakazo/contracts";
import { MarketplaceBotSchema } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setStatus: vi.fn(),
  toastError: vi.fn(),
}));

const rpcClient = () => ({
  botMarketplace: { admin: { update: api.update, setStatus: api.setStatus } },
});
vi.mock("../lib/query/query", () => ({
  useSave: ({
    save,
    onFailed,
  }: {
    save: (input: never, client: unknown) => Promise<unknown>;
    onFailed?: (error: Error) => void;
  }) => ({
    run: (input: never) => void save(input, rpcClient()).catch((error: Error) => onFailed?.(error)),
    pending: false,
    input: undefined,
    error: null,
  }),
  useSpaceQueries: () => ({
    botMarketplace: {
      admin: {
        list: {
          key: () => ["admin-bots"],
          queryOptions: ({ input }: { input: { status?: string } }) => ({
            queryKey: ["admin-bots", input.status ?? "all"],
            queryFn: () => api.list(input),
          }),
        },
      },
    },
  }),
}));
vi.mock("../lib/query/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../components/bot-marketplace/admin-bot-editor", () => ({
  AdminBotEditor: ({ row }: { row: { slug: string } | null }) => (
    <div role="dialog" data-testid="bot-editor">
      {row ? row.slug : "new"}
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
    Badge: Pass,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    Spinner: () => <span role="status" />,
    Tabs: Pass,
    TabsList: Pass,
    TabsTrigger: Pass,
    toast: { error: api.toastError },
  };
});

import { AdminBotsPanel } from "./AdminBotsPanel";

const listing = MarketplaceBotSchema.parse({
  id: "morning-briefing",
  version: 1,
  name: "Morning briefing",
  summary: "A weekday morning overview.",
  sample: "**Today**\n- 10:00 design review",
  description: "A scannable briefing every weekday morning.",
  instructions: "Summarise the day; never send without confirmation.",
  skills: [],
  routines: [],
  apps: [],
  author: { name: "Rakazo Team" },
  license: "Apache-2.0",
  category: "personal",
  tagline: "Your weekday morning overview.",
  outcomes: ["A scannable morning briefing."],
});

const row: MarketplaceBotAdminRow = {
  slug: "morning-briefing",
  version: 1,
  status: "draft",
  featured: false,
  sortOrder: 0,
  listing,
  publishedAt: null,
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockReset().mockResolvedValue([row]);
  api.create.mockReset().mockResolvedValue(row);
  api.update.mockReset().mockResolvedValue(row);
  api.setStatus.mockReset().mockResolvedValue({ ...row, status: "published" });
  api.toastError.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AdminBotsPanel />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => {
    if (!container.querySelector('[data-testid="admin-bots"] li')) throw new Error("Loading");
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

it("lists catalog rows and publishes from the row", async () => {
  expect(api.list).toHaveBeenCalledWith({});
  const item = container.querySelector('[data-testid="admin-bots"] li');
  expect(item?.textContent).toContain("Morning briefing");
  expect(item?.textContent).toContain("Draft");
  await click(button("Publish", item!));
  expect(api.setStatus).toHaveBeenCalledWith({
    slug: "morning-briefing",
    status: "published",
  });
});

it("toggles featured without touching the listing", async () => {
  const star = container.querySelector<HTMLButtonElement>('button[aria-label="Featured"]');
  await click(star!);
  expect(api.update).toHaveBeenCalledWith({ slug: "morning-briefing", featured: true });
});

it("opens the editor for a new bot and for a row", async () => {
  await click(button("New bot"));
  expect(container.querySelector('[data-testid="bot-editor"]')?.textContent).toBe("new");
  await click(button("Edit"));
  expect(container.querySelector('[data-testid="bot-editor"]')?.textContent).toBe(
    "morning-briefing",
  );
});
