import { describe, expect, it } from "vitest";
import {
  BOT_MARKETPLACE_CHANGED,
  isBotMarketplaceChanged,
  MarketplaceBotAdminUpdateInput,
  MarketplaceBotInstallInput,
  MarketplaceBotSchema,
  marketplaceBotIntro,
  marketplaceBotTemplate,
} from "./bot-marketplace.js";

const listing = {
  id: "morning-briefing",
  version: 1,
  name: "Morning briefing",
  summary: "A weekday morning overview.",
  sample: "**Today**\n- 10:00 design review",
  description: "A scannable briefing every weekday morning.",
  instructions: "Summarise the day; never send without confirmation.",
  skills: [],
  routines: [{ name: "Morning briefing", prompt: "Summarise my day", crons: ["0 8 * * 1-5"] }],
  apps: ["gmail"],
  author: { name: "Rakazo Team" },
  license: "Apache-2.0",
  category: "personal",
  tagline: "Your weekday morning overview.",
  outcomes: ["A scannable morning briefing."],
  intro: "I brief you every weekday morning. Nothing is sent without your confirmation.",
  firstQuestion: "Which city should I watch the weather for?",
};

describe("MarketplaceBotSchema", () => {
  it("parses a complete listing and defaults tags", () => {
    const parsed = MarketplaceBotSchema.parse(listing);
    expect(parsed.tags).toEqual([]);
    expect(parsed.intro).toBe(listing.intro);
  });

  it("links only to web addresses", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://example.test/a"]) {
      expect(
        MarketplaceBotSchema.safeParse({ ...listing, author: { name: "A", url } }).success,
      ).toBe(false);
      expect(MarketplaceBotSchema.safeParse({ ...listing, homepage: url }).success).toBe(false);
    }
    expect(
      MarketplaceBotSchema.safeParse({
        ...listing,
        author: { name: "A", url: "https://example.test/a" },
        homepage: "http://example.test",
      }).success,
    ).toBe(true);
  });

  it("keeps the template's no-secrets boundary", () => {
    for (const field of ["apiKeys", "model", "memory", "mcpServers", "history", "secrets"]) {
      expect(
        MarketplaceBotSchema.safeParse({ ...listing, [field]: [] }).success,
        `field ${field} must be refused`,
      ).toBe(false);
    }
  });

  it("only accepts the controlled categories", () => {
    expect(MarketplaceBotSchema.safeParse({ ...listing, category: "marketing" }).success).toBe(
      false,
    );
  });

  it("keeps the template slug rules", () => {
    for (const id of ["Morning-Briefing", "morning briefing", "-morning", "morning-"]) {
      expect(MarketplaceBotSchema.safeParse({ ...listing, id }).success, `id ${id}`).toBe(false);
    }
  });

  it("requires at least one outcome and allows a silent intro", () => {
    expect(MarketplaceBotSchema.safeParse({ ...listing, outcomes: [] }).success).toBe(false);
    const { intro: _intro, firstQuestion: _question, ...silent } = listing;
    expect(MarketplaceBotSchema.safeParse(silent).success).toBe(true);
  });
});

describe("marketplaceBotTemplate", () => {
  it("leaves market metadata out of the install pipeline", () => {
    const template = marketplaceBotTemplate(MarketplaceBotSchema.parse(listing));
    expect(template).toEqual({
      id: "morning-briefing",
      version: 1,
      name: "Morning briefing",
      summary: "A weekday morning overview.",
      sample: listing.sample,
      description: listing.description,
      instructions: listing.instructions,
      skills: [],
      routines: listing.routines,
      apps: ["gmail"],
    });
  });
});

describe("install and admin inputs", () => {
  it("requires the version the user saw", () => {
    expect(
      MarketplaceBotInstallInput.safeParse({ slug: "morning-briefing", version: 0 }).success,
    ).toBe(false);
    expect(
      MarketplaceBotInstallInput.safeParse({ slug: "morning-briefing", version: 1 }).success,
    ).toBe(true);
  });

  it("allows metadata-only updates", () => {
    expect(
      MarketplaceBotAdminUpdateInput.safeParse({ slug: "morning-briefing", featured: true })
        .success,
    ).toBe(true);
  });
});

it("recognises the changed-listing refusal", () => {
  expect(isBotMarketplaceChanged({ data: { reason: BOT_MARKETPLACE_CHANGED } })).toBe(true);
  expect(isBotMarketplaceChanged({ data: { reason: "template_changed" } })).toBe(false);
  expect(isBotMarketplaceChanged(null)).toBe(false);
});

describe("marketplaceBotIntro", () => {
  const parsed = MarketplaceBotSchema.parse(listing);

  it("puts the first question after the intro", () => {
    expect(marketplaceBotIntro(parsed)).toBe(`${listing.intro}\n\n${listing.firstQuestion}`);
  });

  it("speaks with either one alone and stays silent with neither", () => {
    expect(marketplaceBotIntro({ ...parsed, firstQuestion: undefined })).toBe(listing.intro);
    expect(marketplaceBotIntro({ ...parsed, intro: undefined })).toBe(listing.firstQuestion);
    expect(marketplaceBotIntro({ ...parsed, intro: undefined, firstQuestion: undefined })).toBe(
      undefined,
    );
  });
});
