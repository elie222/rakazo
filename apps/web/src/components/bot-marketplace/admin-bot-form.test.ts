import { MarketplaceBotSchema } from "@rakazo/contracts";
import { expect, it } from "vitest";
import {
  copyFromBot,
  issuesByField,
  listingFields,
  newListing,
  parseListing,
  slugFromName,
} from "./admin-bot-form";

const listing = MarketplaceBotSchema.parse({
  id: "morning-briefing",
  version: 3,
  name: "Morning briefing",
  summary: "A custom summary.",
  sample: "**Today**\n- 10:00 design review",
  description: "Copied from the bot.",
  instructions: "Summarise the day; never send without confirmation.",
  skills: [{ name: "Weather check", description: "Looks up the forecast.", body: "Use the API." }],
  routines: [{ name: "Briefing", prompt: "Send it.", crons: ["0 8 * * 1-5", "0 9 * * 6"] }],
  apps: ["gmail"],
  author: { name: "Someone", url: "https://example.com" },
  license: "MIT",
  category: "sales",
  tagline: "Your weekday morning overview.",
  outcomes: ["A scannable briefing.", "Nothing sent unasked."],
  setupMinutes: 5,
  homepage: "https://example.com/bot",
  tags: ["morning"],
  versionNote: "Added weather.",
  intro: "I brief you every morning.",
  firstQuestion: "Which city?",
});

const written = {
  tagline: "Know which meetings need prep.",
  outcomes: " Lists the meetings \n\n Flags prep ",
  sample: "10:00 review",
};

it("turns a name into a catalog slug", () => {
  expect(slugFromName("  Morning Briefing! ")).toBe("morning-briefing");
  expect(slugFromName("晨报")).toBe("");
  expect(slugFromName(`${"a".repeat(70)}-b`)).toHaveLength(64);
});

it("round-trips a listing, keeping what the form does not edit", () => {
  const { form, base } = listingFields(listing);
  const parsed = parseListing(form, base, "bot-fallback");
  expect(parsed.success && parsed.data).toEqual(listing);
});

it("builds a new listing from the source bot and what the operator wrote", () => {
  const { form, base } = newListing();
  const copied = copyFromBot(
    form,
    {
      name: "晨间简报",
      description: "",
      instructions: "Summarise the day.",
      skills: [],
      routines: [{ name: "Daily", prompt: "Go.", crons: ["0 8 * * *"] }],
    },
    false,
  );
  expect(copied.name).toBe("晨间简报");
  const parsed = parseListing({ ...copied, ...written }, base, "bot-fallback");
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  // A name with no letters or digits has no slug, so the fallback is used.
  expect(parsed.data.id).toBe("bot-fallback");
  expect(parsed.data.summary).toBe("Know which meetings need prep.");
  expect(parsed.data.outcomes).toEqual(["Lists the meetings", "Flags prep"]);
  expect(parsed.data.routines).toHaveLength(1);
  expect(
    parseListing({ ...copied, ...written, apps: " gmail,\n slack " }, base, "x"),
  ).toMatchObject({
    data: { apps: ["gmail", "slack"] },
  });
});

it("names a new listing after its display name", () => {
  const { form, base } = newListing();
  const parsed = parseListing(
    { ...form, ...written, name: "Daily Digest", instructions: "Summarise." },
    base,
    "bot-fallback",
  );
  expect(parsed.success && parsed.data.id).toBe("daily-digest");
});

it("keeps a name someone chose when copying from a bot", () => {
  const { form } = newListing();
  const bot = { name: "Bot name", description: "", instructions: "x", skills: [], routines: [] };
  expect(copyFromBot({ ...form, name: "Mine" }, bot, true).name).toBe("Mine");
  expect(copyFromBot({ ...form, name: "Mine" }, bot, false).name).toBe("Bot name");
});

it("reports one problem per field", () => {
  const { form, base } = newListing();
  const parsed = parseListing(form, base, "bot-fallback");
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  const keys = [...issuesByField(parsed.error.issues).keys()];
  expect(keys).toEqual(
    expect.arrayContaining(["name", "tagline", "outcomes", "sample", "instructions"]),
  );
  expect(keys).not.toContain("author");
});
