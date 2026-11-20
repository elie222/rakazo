// @vitest-environment jsdom
import { MarketplaceBotSchema } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../lib/routines/cron", () => ({ cronLabels: () => ({}) }));

import { BotMarketplaceDetail } from "./bot-marketplace-detail";

const listing = MarketplaceBotSchema.parse({
  id: "morning-briefing",
  version: 1,
  name: "Morning briefing",
  summary: "A weekday morning overview.",
  sample: "**Today**",
  description: "A scannable briefing every weekday morning.",
  instructions: "Summarise the day.",
  skills: [],
  routines: [],
  apps: [],
  author: { name: "BotONE Team", url: "https://example.test/team" },
  license: "Apache-2.0",
  category: "personal",
  tagline: "Your weekday morning overview.",
  outcomes: ["A short briefing at 8:00.", "Nothing is sent without you."],
});

let host: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
});
afterEach(() => host.remove());

async function render(value: typeof listing) {
  const root = createRoot(host);
  await act(async () => root.render(<BotMarketplaceDetail listing={value} />));
  return () => act(() => root.unmount());
}

it("shows what the bot delivers, who made it and its license", async () => {
  const unmount = await render(listing);
  expect([...host.querySelectorAll("li")].map((item) => item.textContent)).toEqual(
    expect.arrayContaining(["A short briefing at 8:00.", "Nothing is sent without you."]),
  );
  const link = host.querySelector<HTMLAnchorElement>('a[href="https://example.test/team"]');
  expect(link?.textContent).toBe("BotONE Team");
  expect(link?.rel).toContain("noreferrer");
  expect(host.textContent).toContain("Apache-2.0");
  unmount();
});

it("names the author without a link when the listing gives no address", async () => {
  const unmount = await render({ ...listing, author: { name: "BotONE Team" } });
  expect(host.querySelector("a")).toBeNull();
  expect(host.textContent).toContain("BotONE Team");
  unmount();
});
