// @vitest-environment jsdom
import type { MarketplaceBotAdminRow } from "@rakazo/contracts";
import { MarketplaceBotSchema } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  onClose: vi.fn(),
  failure: null as Error | null,
}));

vi.mock("../../lib/query/query", () => ({
  useSpaceQueries: () => ({ botMarketplace: { admin: { list: { key: () => ["admin-bots"] } } } }),
  useSave: ({
    save,
    onSaved,
  }: {
    save: (input: never, client: unknown) => Promise<unknown>;
    onSaved?: (saved: unknown) => void;
  }) => ({
    run: (input: never) => void save(input, { botMarketplace: { admin: api } }).then(onSaved),
    pending: false,
    error: api.failure,
  }),
}));
vi.mock("../../lib/query/user-error", () => ({
  errorText: (error: Error) => error.message,
}));
vi.mock("./bot-marketplace-detail", () => ({
  BotMarketplaceDetail: ({ listing }: { listing: { name: string } }) => (
    <div data-testid="bot-preview">{listing.name}</div>
  ),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { AdminBotEditor } from "./admin-bot-editor";

const listing = MarketplaceBotSchema.parse({
  id: "morning-briefing",
  version: 1,
  name: "Morning briefing",
  summary: "A weekday morning overview.",
  sample: "**Today**",
  description: "",
  instructions: "Summarise the day.",
  skills: [],
  routines: [],
  apps: [],
  author: { name: "BotONE Team" },
  license: "Apache-2.0",
  category: "personal",
  tagline: "Your weekday morning overview.",
  outcomes: ["A scannable briefing."],
});
const row: MarketplaceBotAdminRow = {
  slug: listing.id,
  version: 1,
  status: "draft",
  featured: false,
  sortOrder: 4,
  listing,
  publishedAt: null,
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function open(editing: MarketplaceBotAdminRow | null) {
  await act(async () => {
    root.render(<AdminBotEditor row={editing} onClose={api.onClose} />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.create.mockReset().mockResolvedValue(row);
  api.update.mockReset().mockResolvedValue(row);
  api.onClose.mockReset();
  api.failure = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!;

function field(label: string) {
  const found = [...dialog().querySelectorAll("label")].find(
    (node) => node.textContent?.trim() === label,
  );
  const control =
    found && dialog().querySelector<HTMLInputElement>(`#${CSS.escape(found.htmlFor)}`);
  if (!control) throw new Error(`Missing field ${label}`);
  return control;
}

async function fill(label: string, value: string) {
  const control = field(label);
  const proto =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(name: string) {
  const found = [...dialog().querySelectorAll("button")].find(
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

it("shows what is missing and saves nothing until the form is complete", async () => {
  await open(null);
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  await click(button("Save"));
  expect(api.create).not.toHaveBeenCalled();
  const problems = [...dialog().querySelectorAll('[role="alert"]')].map((node) => node.textContent);
  expect(problems.length).toBeGreaterThan(3);
  expect(problems).toContain("Required");
});

it("creates a bot from the form, with the slug following the name", async () => {
  await open(null);
  await fill("Name", "Daily Digest");
  expect(field("Slug").value).toBe("daily-digest");
  await fill("Tagline", "Everything you missed.");
  await fill("Summary", "A short digest.");
  await fill("Outcomes", "A digest.\nNo noise.");
  await fill("Instructions", "Summarise; never send unasked.");
  await fill("Sample message", "**Digest**");

  await click(button("Preview"));
  expect(dialog().querySelector('[data-testid="bot-preview"]')?.textContent).toBe("Daily Digest");

  await click(button("Save"));
  expect(api.create).toHaveBeenCalledWith({
    listing: expect.objectContaining({
      id: "daily-digest",
      version: 1,
      name: "Daily Digest",
      category: "personal",
      outcomes: ["A digest.", "No noise."],
      author: { name: "BotONE Team", url: undefined },
    }),
  });
  expect(api.onClose).toHaveBeenCalled();
});

it("keeps the slug a person typed", async () => {
  await open(null);
  await fill("Slug", "my-own");
  await fill("Name", "Something else");
  expect(field("Slug").value).toBe("my-own");
});

it("edits a bot under its own slug and keeps its sort order", async () => {
  await open(row);
  expect(() => field("Slug")).toThrow();
  expect(field("Name").value).toBe("Morning briefing");
  await fill("Tagline", "A new promise.");
  await fill("Sort order", "9");
  await click(button("Save"));
  expect(api.update).toHaveBeenCalledWith({
    slug: "morning-briefing",
    listing: expect.objectContaining({ id: "morning-briefing", tagline: "A new promise." }),
    sortOrder: 9,
  });
});

it("adds a skill and a routine and reports their fields", async () => {
  await open(row);
  await click(button("Add skill"));
  await click(button("Add routine"));
  await click(button("Save"));
  expect(api.update).not.toHaveBeenCalled();
  expect(dialog().textContent).toContain("Required");

  await click(dialog().querySelector<HTMLElement>('[aria-label="Remove skill 1"]')!);
  expect(dialog().querySelector('[aria-label="Remove skill 1"]')).toBeNull();
});

it("shows a failed save in the dialog", async () => {
  api.failure = new Error("Slug already taken");
  await open(row);
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("Slug already taken");
});
