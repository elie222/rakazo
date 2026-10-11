import { expect, test } from "@playwright/test";
import type { Bot, BotTemplate } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openNewBot, rpc, signup } from "./helpers";

const instructions = "Ask me which folders to organize and which messages to preserve. ".repeat(80);
const templates: BotTemplate[] = [
  ...Array.from({ length: 8 }, (_, index) => ({
    slug: `template-${index}`,
    name: `Template ${index + 1}`,
    description: "",
    instructions,
    featured: true,
  })),
  {
    slug: "inbox",
    name: "Inbox Manager",
    description: "Organize email",
    instructions,
    featured: false,
  },
];

test("template picks and searchable catalog fill editable instructions without truncation", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/bots/templates", (route) =>
    route.fulfill({ json: { json: templates } }),
  );
  await signup(page, `templates-${Date.now()}@rakazo.test`, "password12", "Template Test");
  await completeOnboarding(page);
  await openNewBot(page);
  const form = page.getByTestId("create-bot-form");
  const row = form.getByTestId("bot-templates");
  await expect(row.getByRole("button")).toHaveCount(9);
  await captureScreenshot(page, testInfo, "bot-template-picks");
  await row.getByRole("button", { name: "Template 1", exact: true }).click();
  await expect(form.getByLabel("Name", { exact: true })).toHaveValue("Template 1");
  await expect(form.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue(
    instructions,
  );
  await row.getByRole("button", { name: "Browse all" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Search" }).fill("email inbox");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "bot-template-search");
  await dialog.getByRole("option", { name: "Inbox Manager" }).click();
  await expect(dialog).toBeHidden();
  await expect(form.getByLabel("Name", { exact: true })).toHaveValue("Inbox Manager");
  await form.getByLabel("Name", { exact: true }).fill("My Inbox");
  await form
    .getByRole("textbox", { name: "Instructions", exact: true })
    .fill(`${instructions}\nKeep drafts.`);
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByPlaceholder("Message My Inbox")).toBeVisible();
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.find((bot) => bot.name === "My Inbox")?.instructions).toBe(
    `${instructions}\nKeep drafts.`,
  );
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
});

test("an unavailable catalog leaves manual creation available", async ({ page }) => {
  await page.route("**/rpc/bots/templates", (route) => route.abort());
  await signup(page, `templates-offline-${Date.now()}@rakazo.test`, "password12", "Template Test");
  await completeOnboarding(page);
  await openNewBot(page);
  const form = page.getByTestId("create-bot-form");
  await expect(form.getByTestId("bot-templates")).toHaveCount(0);
  await form.getByLabel("Name", { exact: true }).fill("Manual Bot");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByPlaceholder("Message Manual Bot")).toBeVisible();
});
