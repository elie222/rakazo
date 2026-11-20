import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, Routine } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers/helpers";

const ADMIN_EMAIL = "admin@rakazo.test";

const routine = { name: "Morning briefing", prompt: "Summarise my day", crons: ["0 8 * * 1-5"] };

const listing = {
  id: "morning-briefing",
  version: 1,
  name: "Morning briefing",
  summary: "A weekday morning overview.",
  sample: "**Today**\n- 10:00 design review\n- 14:00 call with Dana",
  description:
    "A scannable briefing every weekday morning: your calendar, the emails waiting on you, and the topics you follow. Nothing is sent or changed without your confirmation.",
  instructions: "Summarise the day; never send without confirmation.",
  skills: [],
  routines: [routine],
  apps: ["gmail"],
  author: { name: "Rakazo Team" },
  license: "Apache-2.0",
  category: "personal",
  tagline: "Your weekday morning overview, only reports never acts.",
  outcomes: ["A scannable morning briefing.", "A list of emails waiting on you."],
  intro: "I brief you every weekday morning. Nothing is sent without your confirmation.",
  firstQuestion: "Which city should I watch the weather for?",
};

/** Fills the listing form the way ops would, one labeled field at a time. */
async function fillListing(page: Page) {
  const field = (label: string) => page.getByLabel(label).first();
  await field("One-line intro").fill(listing.tagline);
  await field("What it does for users").fill(listing.outcomes.join("\n"));
  await page.getByText("Example and opening line", { exact: true }).click();
  await field("Example output").fill(listing.sample);
  await field("First message after install").fill(listing.intro);
  await field("First question").fill(listing.firstQuestion);
  await page.getByText("Copied with the template", { exact: true }).click();
  await field("Apps").fill(listing.apps.join(", "));
}

/** Open signups get a session at once; the emailed link marks the address verified. */
async function verifyEmail(page: import("@playwright/test").Page, email: string) {
  const emailApi = process.env.API_URL ?? "http://127.0.0.1:3110";
  const sentToUser = async () => {
    const response = await page.request.get(`${emailApi}/__e2e/emails`);
    const messages = (await response.json()) as Array<{
      to: string;
      subject: string;
      text: string;
    }>;
    // The brand in the subject follows the deployment's product name.
    return messages.filter(
      (message) => message.to === email && message.subject.startsWith("Verify your"),
    );
  };
  await expect.poll(async () => (await sentToUser()).length).toBeGreaterThan(0);
  const url = (await sentToUser()).at(-1)!.text.match(/https?:\/\/\S+/)?.[0];
  expect(url).toBeTruthy();
  await page.goto(url!);
}

test("ops publishes a bot; a user adds it from the market and uses it", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const stamp = Date.now();

  // ── Ops: configure and publish ──────────────────────────────────────────────
  await signup(page, ADMIN_EMAIL, "password12", "Market Admin");
  await verifyEmail(page, ADMIN_EMAIL);
  await page.goto("/onboarding");
  await completeOnboarding(page);

  await page.goto("/admin/bots");
  await expect(page.getByRole("heading", { name: "Bot market", exact: true })).toBeVisible();
  const panel = page.getByTestId("admin-bots");
  await expect(panel.getByText("No bots here yet.", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "01-ops-console-empty");

  // The listing is built from one of the admin's own bots.
  const source = await rpc<Bot>(page, "bots/create", {
    name: listing.name,
    description: listing.description,
    instructions: listing.instructions,
  });
  await rpc(page, "routines/create", { botId: source.id, ...routine });

  await panel.getByRole("button", { name: "New bot", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/bots\/new$/);
  await page.getByRole("button", { name: "Choose a bot", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: new RegExp(listing.name) })
    .click();
  await expect(page.getByLabel("Display name")).toHaveValue(listing.name);
  await fillListing(page);
  await captureScreenshot(page, testInfo, "02-ops-listing-form");
  await page.getByRole("button", { name: "Preview listing" }).click();
  const preview = page.getByTestId("bot-listing-preview");
  await expect(preview.getByRole("heading", { name: "Morning briefing", level: 2 })).toBeVisible();
  await expect(preview.getByText("Demo data", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "03-ops-listing-preview");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/bots$/);
  const row = panel.getByRole("listitem").filter({ hasText: "Morning briefing" });
  await expect(row.getByText("Draft", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "04-ops-draft-row");

  // A draft is invisible to users.
  expect((await rpc<{ entries: unknown[] }>(page, "botMarketplace/catalog", {})).entries).toEqual(
    [],
  );

  await row.getByRole("button", { name: "Featured", exact: true }).click();
  await row.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(row.getByText("Published", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "05-ops-published-row");
  const catalog = await rpc<{ entries: { slug: string; botId: string | null }[] }>(
    page,
    "botMarketplace/catalog",
    {},
  );
  expect(catalog.entries).toEqual([
    expect.objectContaining({ slug: "morning-briefing", botId: null }),
  ]);

  // ── User: browse the market, add the bot, connect an app, use it ────────────
  const memberContext = await page.context().browser()!.newContext();
  const member = await memberContext.newPage();
  await member.setViewportSize({ width: 1280, height: 900 });
  await signup(member, `market-user-${stamp}@rakazo.test`, "password12", "Market User");
  await completeOnboarding(member);

  await member.getByRole("button", { name: "Connect apps", exact: true }).click();
  const integrations = member.getByRole("dialog", { name: "Integrations", exact: true });
  const marketEntry = integrations.getByRole("button", { name: "Bot market", exact: true });
  await expect(marketEntry).toBeVisible();
  await captureScreenshot(member, testInfo, "05a-user-market-entry");
  await marketEntry.click();
  const market = member.getByRole("dialog", { name: "Bot market", exact: true });
  await expect(market.getByTestId("market-featured-card")).toHaveCount(1);
  await expect(market.getByTestId("market-row")).toHaveCount(1);
  await captureScreenshot(member, testInfo, "06-user-market-browse");

  await market.getByTestId("market-row").click();
  const detail = market.getByTestId("bot-marketplace-detail");
  await expect(detail.getByRole("heading", { name: "Morning briefing" })).toBeVisible();
  await expect(detail.getByText("A scannable morning briefing.", { exact: true })).toBeVisible();
  await expect(detail.getByText("Gmail", { exact: true })).toBeVisible();
  await expect(detail.getByText(/paused until you turn it on$/)).toBeVisible();
  await expect(detail.getByText("Demo data, not your real content.")).toBeVisible();
  await captureScreenshot(member, testInfo, "07-user-market-detail");

  await detail.getByRole("button", { name: "Add bot", exact: true }).click();
  await expect(market).toHaveCount(0);
  await expect(member).toHaveURL(/\/app\/[^/?]+/);
  const botId = new URL(member.url()).pathname.split("/").pop()!;
  await expect(member.getByTestId("import-setup-card")).toBeVisible();
  // The listing's fixed intro and first question open the chat, with no model run.
  const botMessages = member.getByTestId("message-bot-bubble");
  await expect(
    botMessages.getByText(
      "I brief you every weekday morning. Nothing is sent without your confirmation.",
    ),
  ).toBeVisible();
  await expect(botMessages.getByText("Which city should I watch the weather for?")).toBeVisible();
  const routines = await rpc<Routine[]>(member, "routines/list", { botId });
  expect(routines.map((routine) => [routine.name, routine.active])).toEqual([
    ["Morning briefing", false],
  ]);
  await captureScreenshot(member, testInfo, "08-user-chat-installed");

  // Connect the app the bot works with, right from the chat.
  const gmailCard = member.getByRole("group", { name: "Gmail connection", exact: true });
  await expect(gmailCard).toBeVisible();
  await gmailCard.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(gmailCard.getByText("Connected", { exact: true })).toBeVisible();
  await captureScreenshot(member, testInfo, "09-user-gmail-connected");

  // Use the bot: ask a question and get a real reply from the runtime.
  await member
    .getByRole("combobox", { name: "Message Morning briefing" })
    .fill("Can you check my Gmail inbox?");
  await member.keyboard.press("Enter");
  await expect(
    member.getByTestId("message-bot-bubble").getByText("Connect Gmail and I’ll check your inbox."),
  ).toBeVisible();
  await captureScreenshot(member, testInfo, "10-user-chat-reply");

  // The market now offers the bot it made instead of a second one.
  await member.goto(`/app/${botId}?market`);
  await expect(market.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  await captureScreenshot(member, testInfo, "11-user-market-added");
  const again = await rpc<{ bot: Bot; created: boolean }>(member, "botMarketplace/install", {
    slug: "morning-briefing",
    version: 1,
  });
  expect(again.created).toBe(false);
  expect(again.bot.id).toBe(botId);

  // A regular member cannot touch the admin API.
  await expect(rpc(member, "botMarketplace/admin/list", {})).rejects.toThrow(/403/);
  await memberContext.close();

  // ── Ops: edit bumps the version; unpublishing hides it without touching installs ──
  await page.goto("/admin/bots");
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("One-line intro").fill("A sharper morning overview.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/bots$/);
  await expect(row.getByText(/v2/)).toBeVisible();
  await captureScreenshot(page, testInfo, "12-ops-version-bump");
  await expect(
    rpc(page, "botMarketplace/install", { slug: "morning-briefing", version: 1 }),
  ).rejects.toThrow(/412/);

  await row.getByRole("button", { name: "Unpublish", exact: true }).click();
  await expect(row.getByText("Unpublished", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "13-ops-unpublished");
  expect((await rpc<{ entries: unknown[] }>(page, "botMarketplace/catalog", {})).entries).toEqual(
    [],
  );
  await expect(rpc(page, "botMarketplace/get", { slug: "morning-briefing" })).rejects.toThrow(
    /404/,
  );
});
