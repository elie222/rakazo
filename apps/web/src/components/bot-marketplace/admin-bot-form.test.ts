import { MarketplaceBotSchema } from "@rakazo/contracts";
import { expect, it } from "vitest";
import {
  emptyForm,
  formFromListing,
  issuesByField,
  parseForm,
  slugFromName,
} from "./admin-bot-form";

const listing = MarketplaceBotSchema.parse({
  id: "morning-briefing",
  version: 3,
  name: "Morning briefing",
  summary: "A weekday morning overview.",
  sample: "**Today**\n- 10:00 design review",
  description: "",
  instructions: "Summarise the day; never send without confirmation.",
  skills: [{ name: "Weather check", description: "Looks up the forecast.", body: "Use the API." }],
  routines: [{ name: "Briefing", prompt: "Send it.", crons: ["0 8 * * 1-5", "0 9 * * 6"] }],
  apps: ["gmail", "googlecalendar"],
  author: { name: "BotONE Team", url: "https://example.com" },
  license: "Apache-2.0",
  category: "sales",
  tagline: "Your weekday morning overview.",
  outcomes: ["A scannable briefing.", "Nothing sent unasked."],
  setupMinutes: 5,
  homepage: "https://example.com/bot",
  tags: ["morning", "email"],
  versionNote: "Added weather.",
  intro: "I brief you every morning.",
  firstQuestion: "Which city?",
});

it("turns a name into a catalog slug", () => {
  expect(slugFromName("  Morning Briefing! ")).toBe("morning-briefing");
  expect(slugFromName("晨报")).toBe("");
  expect(slugFromName(`${"a".repeat(70)}-b`)).toHaveLength(64);
});

it("round-trips a full listing through the form", () => {
  const parsed = parseForm(formFromListing(listing));
  expect(parsed.success && parsed.data).toEqual(listing);
});

it("reads lists from lines and commas, and drops blanks", () => {
  const parsed = parseForm({
    ...formFromListing(listing),
    outcomes: " One \n\n Two ",
    tags: "a, b,\nc",
    apps: "gmail,\n slack",
    authorUrl: "",
    homepage: " ",
    setupMinutes: "",
  });
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.outcomes).toEqual(["One", "Two"]);
  expect(parsed.data.tags).toEqual(["a", "b", "c"]);
  expect(parsed.data.apps).toEqual(["gmail", "slack"]);
  expect(parsed.data.author.url).toBeUndefined();
  expect(parsed.data.homepage).toBeUndefined();
  expect(parsed.data.setupMinutes).toBeUndefined();
});

it("reports one problem per field, in the field the person edits", () => {
  const parsed = parseForm({
    ...emptyForm(),
    setupMinutes: "soon",
    skills: [{ name: "1 bad", description: "d", body: "b" }],
    routines: [{ name: "r", prompt: "p", crons: "" }],
  });
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  const keys = [...issuesByField(parsed.error.issues).keys()];
  expect(keys).toEqual(
    expect.arrayContaining([
      "id",
      "name",
      "outcomes",
      "setupMinutes",
      "skills.0.name",
      "routines.0.crons",
    ]),
  );
  expect(keys).not.toContain("author.name");
});
