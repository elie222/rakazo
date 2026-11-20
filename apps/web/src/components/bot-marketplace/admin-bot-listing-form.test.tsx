// @vitest-environment jsdom
import type { MarketplaceBotAdminRow } from "@rakazo/contracts";
import { MarketplaceBotSchema } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  setStatus: vi.fn(),
  fromBot: vi.fn(),
  sources: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../../lib/query/query", () => ({
  useSpaceQueries: () => ({
    botMarketplace: {
      admin: {
        list: { key: () => ["admin-bots"] },
        sources: {
          queryOptions: () => ({ queryKey: ["sources"], queryFn: () => api.sources() }),
        },
      },
    },
  }),
  useSave: ({
    save,
    onSaved,
  }: {
    save: (input: never, client: unknown) => Promise<unknown>;
    onSaved?: (saved: unknown) => void;
  }) => ({
    run: (input: never) =>
      void save(input, { botMarketplace: { admin: api } }).then((saved) => onSaved?.(saved)),
    pending: false,
    error: null,
  }),
}));
vi.mock("../../lib/query/user-error", () => ({ errorText: (error: Error) => error.message }));
vi.mock("../../lib/routines/cron", () => ({ cronLabels: () => ({}) }));
vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/core")>()),
  formatCron: (cron: string) => `at ${cron}`,
}));
vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => api.navigate,
}));
vi.mock("./admin-bot-listing-preview", () => ({
  AdminBotListingPreview: ({ listing }: { listing: { name: string } }) => (
    <div data-testid="bot-preview">{listing.name}</div>
  ),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));

import { AdminBotListingForm } from "./admin-bot-listing-form";

const listing = MarketplaceBotSchema.parse({
  id: "morning-briefing",
  version: 2,
  name: "Morning briefing",
  summary: "A weekday morning overview.",
  sample: "**Today**",
  description: "",
  instructions: "Summarise the day.",
  skills: [],
  routines: [{ name: "Daily", prompt: "Go.", crons: ["0 8 * * 1-5"] }],
  apps: ["gmail"],
  author: { name: "BotONE Team" },
  license: "Apache-2.0",
  category: "personal",
  tagline: "Your weekday morning overview.",
  outcomes: ["A scannable briefing."],
});
const row = (status: MarketplaceBotAdminRow["status"]): MarketplaceBotAdminRow => ({
  slug: listing.id,
  version: 2,
  status,
  featured: false,
  sortOrder: 0,
  listing,
  publishedAt: null,
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function open(editing: MarketplaceBotAdminRow | null) {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AdminBotListingForm row={editing} />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.create.mockReset().mockResolvedValue(row("draft"));
  api.update.mockReset().mockResolvedValue(row("draft"));
  api.setStatus.mockReset().mockResolvedValue(row("published"));
  api.navigate.mockReset();
  api.sources
    .mockReset()
    .mockResolvedValue([
      { botId: "bot-1", name: "晨间简报", spaceName: "Ops", skills: 1, routines: 1 },
    ]);
  api.fromBot.mockReset().mockResolvedValue({
    name: "晨间简报",
    description: "",
    instructions: "Summarise the day.",
    skills: [{ name: "Calendar", description: "Reads the day.", body: "List meetings." }],
    routines: [{ name: "Daily", prompt: "Use @Calendar", crons: ["0 8 * * 1-5"] }],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const scope = () => document.body;

function control(label: string) {
  const found = [...scope().querySelectorAll("label")].find((node) =>
    node.textContent?.trim().startsWith(label),
  );
  const target = found && scope().querySelector<HTMLInputElement>(`#${CSS.escape(found.htmlFor)}`);
  if (!target) throw new Error(`Missing field ${label}`);
  return target;
}

async function fill(label: string, value: string) {
  const target = control(label);
  const proto =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(name: string) {
  const found = [...scope().querySelectorAll("button")].find((node) =>
    node.textContent?.trim().startsWith(name),
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function writeListing() {
  await fill("One-line intro", "Know which meetings need prep.");
  await fill("What it does for users", "Lists the meetings.");
  await fill("Example output", "10:00 review");
}

it("asks for what is missing and stays on the form", async () => {
  await open(null);
  expect(scope().textContent).toContain("No bot chosen");
  expect(scope().textContent).toContain("Unsaved");
  await click(button("Preview listing"));
  expect(scope().querySelector('[data-testid="bot-preview"]')).toBeNull();
  expect([...scope().querySelectorAll('[role="alert"]')].map((node) => node.textContent)).toContain(
    "Required",
  );
});

it("copies a chosen bot, previews the listing and publishes it", async () => {
  await open(null);
  await click(button("Choose a bot"));
  await vi.waitFor(() => expect(scope().textContent).toContain("Ops"));
  await click(scope().querySelector<HTMLElement>("li button")!);
  await vi.waitFor(() => expect(api.fromBot).toHaveBeenCalledWith({ botId: "bot-1" }));
  await vi.waitFor(() => expect(control("Display name").value).toBe("晨间简报"));
  expect(scope().textContent).toContain("1 skill");
  expect(scope().textContent).toContain("1 routine");

  await writeListing();
  await click(button("Preview listing"));
  expect(scope().querySelector('[data-testid="bot-preview"]')?.textContent).toBe("晨间简报");

  await click(button("Publish to market"));
  expect(api.create).toHaveBeenCalledWith({
    listing: expect.objectContaining({
      version: 1,
      name: "晨间简报",
      tagline: "Know which meetings need prep.",
      outcomes: ["Lists the meetings."],
      instructions: "Summarise the day.",
      skills: [{ name: "Calendar", description: "Reads the day.", body: "List meetings." }],
    }),
  });
  await vi.waitFor(() =>
    expect(api.setStatus).toHaveBeenCalledWith({
      slug: "morning-briefing",
      status: "published",
    }),
  );
  await vi.waitFor(() => expect(api.navigate).toHaveBeenCalledWith("/admin/bots"));
});

it("leaves out a skill that is unticked", async () => {
  await open(null);
  await click(button("Choose a bot"));
  await vi.waitFor(() => expect(scope().textContent).toContain("Ops"));
  await click(scope().querySelector<HTMLElement>("li button")!);
  await vi.waitFor(() => expect(control("Display name").value).toBe("晨间简报"));
  const skill = scope().querySelector<HTMLElement>('[role="checkbox"]');
  if (!skill) throw new Error("Missing skill checkbox");
  expect(skill.getAttribute("aria-checked")).toBe("true");
  await click(skill);
  expect(skill.getAttribute("aria-checked")).toBe("false");
  await writeListing();
  await click(button("Save draft"));
  await vi.waitFor(() =>
    expect(api.create).toHaveBeenCalledWith({
      listing: expect.objectContaining({ skills: [] }),
    }),
  );
});

it("goes back to the market list from the header", async () => {
  await open(null);
  const back = scope().querySelector<HTMLElement>('[aria-label="Back to Bot market"]');
  if (!back) throw new Error("Missing back button");
  await click(back);
  expect(api.navigate).toHaveBeenCalledWith("/admin/bots");
});

it("keeps a typed name when another bot is chosen", async () => {
  await open(null);
  await fill("Display name", "My briefing");
  await click(button("Choose a bot"));
  await vi.waitFor(() => expect(scope().textContent).toContain("Ops"));
  await click(scope().querySelector<HTMLElement>("li button")!);
  await vi.waitFor(() => expect(scope().textContent).toContain("1 skill"));
  expect(control("Display name").value).toBe("My briefing");
});

it("saves a new listing as a draft without publishing", async () => {
  await open(null);
  await fill("Display name", "Daily Digest");
  await writeListing();
  await fill("Instructions", "Summarise.");
  await click(button("Save draft"));
  await vi.waitFor(() => expect(api.create).toHaveBeenCalled());
  expect(api.create.mock.calls[0]?.[0].listing.id).toBe("daily-digest");
  await vi.waitFor(() => expect(api.navigate).toHaveBeenCalledWith("/admin/bots"));
  expect(api.setStatus).not.toHaveBeenCalled();
});

it("changes a published listing under its own slug, with no publish step", async () => {
  await open(row("published"));
  expect(scope().querySelector("h1")?.textContent).toBe("Edit listing");
  expect(scope().textContent).not.toContain("Unsaved");
  await fill("One-line intro", "A new promise.");
  expect(scope().textContent).toContain("Unsaved");
  await click(button("Preview listing"));
  expect(() => button("Publish to market")).toThrow();
  await click(button("Save"));
  await vi.waitFor(() =>
    expect(api.update).toHaveBeenCalledWith({
      slug: "morning-briefing",
      listing: expect.objectContaining({
        id: "morning-briefing",
        tagline: "A new promise.",
        apps: ["gmail"],
        summary: "A weekday morning overview.",
      }),
    }),
  );
  expect(api.create).not.toHaveBeenCalled();
});

it("offers a draft to be published", async () => {
  await open(row("draft"));
  await click(button("Preview listing"));
  await click(button("Publish to market"));
  await vi.waitFor(() =>
    expect(api.setStatus).toHaveBeenCalledWith({ slug: "morning-briefing", status: "published" }),
  );
});
