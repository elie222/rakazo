import { marketplaceBotTemplate } from "@rakazo/contracts";
import { BOT_TEMPLATES } from "@rakazo/core";
import { expect, it } from "vitest";
import { seedMarketplace, starterListings } from "./marketplace-seed.js";

function fakeDb(existing: string[] = []) {
  const created: Record<string, unknown>[] = [];
  return {
    created,
    db: {
      marketplaceBot: {
        findMany: async () => existing.map((slug) => ({ slug })),
        create: async (args: { data: Record<string, unknown> }) => created.push(args.data),
      },
    },
  };
}

it("lists every built-in template unchanged, so a listing installs exactly what was reviewed", () => {
  const listings = starterListings();
  expect(listings.map((listing) => listing.id)).toEqual(BOT_TEMPLATES.map((item) => item.id));
  for (const template of BOT_TEMPLATES) {
    const listing = listings.find((item) => item.id === template.id)!;
    expect(marketplaceBotTemplate(listing)).toEqual(template);
  }
});

it("adds missing listings as drafts and leaves an operator's own listing alone", async () => {
  const { db, created } = fakeDb(["morning-briefing"]);
  const added = await seedMarketplace(db as never, { publish: false });
  expect(added).toEqual(["inbox-triage", "pr-reviewer", "topic-watch"]);
  expect(created.map((row) => row.status)).toEqual(["draft", "draft", "draft"]);
  expect(created.every((row) => row.publishedAt === null)).toBe(true);
});

it("publishes only when asked, and adds nothing the second time", async () => {
  const { db, created } = fakeDb();
  await seedMarketplace(db as never, { publish: true });
  expect(created.map((row) => row.status)).toEqual(Array(BOT_TEMPLATES.length).fill("published"));
  expect(created.every((row) => row.publishedAt instanceof Date)).toBe(true);

  const again = fakeDb(BOT_TEMPLATES.map((item) => item.id));
  expect(await seedMarketplace(again.db as never, { publish: true })).toEqual([]);
  expect(again.created).toEqual([]);
});
