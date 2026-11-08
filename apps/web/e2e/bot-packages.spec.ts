import { expect, test } from "@playwright/test";
import type {
  Bot,
  BotPackageDocument,
  BotPackageReceipt,
  MemoryDocument,
  Routine,
} from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openBotPanelTab, rpc, signup } from "./helpers";

const skillName = "package-review-recipe";
const source = JSON.stringify({
  format: "openmaus.grok/1",
  name: "Package reviewer",
  title: "Review sources",
  description: "Synthetic portable assistant",
  instructions: "First instruction line\n<img src=x onerror=alert(1)>\nLast instruction line\n",
  skills: [
    {
      name: skillName,
      description: "Review source material",
      body: "Keep the original evidence.\nNever send a message automatically.\n",
    },
  ],
  routines: [
    {
      name: "Morning review",
      cron: "0 9 * * 1-5",
      timeZone: "UTC",
      prompt: "Review the supplied material.",
    },
    { name: "On new email", schedule: "When a new email arrives", prompt: "Review the email." },
  ],
  plugins: ["GitHub"],
  memories: ["Synthetic note selected separately"],
});

test("package review preserves text, keeps execution off, and explicitly enables or exports shared skills", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await signup(page, `package-review-${Date.now()}@example.test`, "password12", "Package reviewer");
  await completeOnboarding(page);
  await rpc(page, "agentSkills/create", {
    name: skillName,
    description: "Existing shared recipe",
    body: "Keep this original shared recipe.",
  });
  const before = await rpc<Bot[]>(page, "bots/list", {});
  let imports = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/botPackages/import")) imports++;
  });
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("import-bot").click();
  const panel = page.getByTestId("bot-package-import");
  await panel.getByLabel("Choose package file", { exact: true }).setInputFiles({
    name: "review.json",
    mimeType: "application/json",
    buffer: Buffer.from(source),
  });
  await expect(panel.getByLabel("Bot package or Grok JSON", { exact: true })).toHaveValue(source);
  await expect(
    panel.getByRole("switch", { name: "Include memory", exact: true }),
  ).not.toBeChecked();
  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = panel.getByTestId("bot-package-document");
  await expect(preview.getByText("Package reviewer", { exact: true })).toBeVisible();
  await expect(preview.locator("pre").first()).toHaveText(JSON.parse(source).instructions);
  await expect(preview.locator("img")).toHaveCount(0);
  await expect(panel.getByTestId("bot-package-left-out")).toContainText("routines[1]");
  await expect(panel.getByTestId("bot-package-left-out")).toContainText(
    "Event or unrecognized schedules need manual setup.",
  );
  expect(imports).toBe(0);
  expect(await rpc<Bot[]>(page, "bots/list", {})).toHaveLength(before.length);
  await captureScreenshot(page, testInfo, "d021-package-review");
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(panel.getByRole("button", { name: "Import as new bot", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await captureScreenshot(page, testInfo, "d021-package-review-320");
  await page.setViewportSize({ width: 1280, height: 1100 });
  await panel.getByRole("button", { name: "Import as new bot", exact: true }).click();
  await expect(panel.getByText("Bot imported", { exact: true })).toBeVisible();
  const after = await rpc<Bot[]>(page, "bots/list", {});
  expect(after).toHaveLength(before.length + 1);
  const imported = after.find((bot) => !before.some((existing) => existing.id === bot.id))!;
  expect(imported.instructions).toBe(JSON.parse(source).instructions);
  expect(imported.modelProvider).toBeNull();
  expect(imported.parentBotId).toBeNull();
  expect(imported.teamChatAmbientEnabled).toBe(false);
  const routines = await rpc<Routine[]>(page, "routines/list", { botId: imported.id });
  expect(routines).toHaveLength(1);
  expect(routines[0]).toMatchObject({
    active: false,
    webhookEnabled: false,
    githubEnabled: false,
  });
  const memory = await rpc<MemoryDocument[]>(page, "memory/list", {
    botId: imported.id,
    scope: "bot",
  });
  expect(
    memory.every((entry) => !entry.content.includes("Synthetic note selected separately")),
  ).toBe(true);
  const skills = panel.getByTestId("bot-package-skills");
  await skills.locator("summary").click();
  await expect(
    skills.getByText("Enabling a skill shares it with your bots in this space.", { exact: true }),
  ).toBeVisible();
  await skills.getByRole("button", { name: "Enable shared skill", exact: true }).click();
  await expect(skills.getByRole("alert")).toBeVisible();
  await expect(
    skills.getByRole("button", { name: "Enable shared skill", exact: true }),
  ).toBeDisabled();
  await captureScreenshot(page, testInfo, "d021-package-skill-conflict");
  await skills.getByRole("button", { name: "Check status", exact: true }).click();
  await skills.getByLabel("Skill name", { exact: true }).fill("package-reviewed-copy");
  await skills.getByRole("button", { name: "Enable shared skill", exact: true }).click();
  await expect(skills.locator("summary")).toContainText("Enabled");
  const original = await rpc<{ content: string }>(page, "agentSkills/get", { name: skillName });
  expect(original.content).toContain("Keep this original shared recipe.");
  await captureScreenshot(page, testInfo, "d021-package-imported");
  await panel.getByRole("button", { name: "Open bot", exact: true }).click();
  await page.waitForURL(`**/app/${imported.id}`);
  await openBotPanelTab(page, "Advanced");
  const settings = page.getByTestId("bot-settings");
  await settings.getByRole("button", { name: "Export package", exact: true }).click();
  const exporting = settings.getByTestId("bot-package-export");
  await expect(
    exporting.getByRole("switch", { name: "Include memory", exact: true }),
  ).not.toBeChecked();
  await expect(
    exporting.getByRole("switch", { name: "package-reviewed-copy", exact: true }),
  ).not.toBeChecked();
  await exporting.getByRole("switch", { name: "package-reviewed-copy", exact: true }).click();
  let downloads = 0;
  page.on("download", () => downloads++);
  await expect(
    exporting.getByRole("button", { name: "Download package", exact: true }),
  ).toHaveCount(0);
  await exporting.getByRole("button", { name: "Preview package", exact: true }).click();
  await expect(exporting.getByTestId("bot-package-document")).toBeVisible();
  expect(downloads).toBe(0);
  await exporting
    .getByRole("button", { name: "Download package", exact: true })
    .scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "d021-package-export");
  const downloadEvent = page.waitForEvent("download");
  await exporting.getByRole("button", { name: "Download package", exact: true }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BotPackageDocument;
  expect(exported.format).toBe("coginebot.package/v1");
  expect(exported.profile.instructions).toBe(imported.instructions);
  expect(exported.memory).toEqual([]);
  expect(exported.skills.map((skill) => skill.name)).toEqual(["package-reviewed-copy"]);
  expect(exported).not.toHaveProperty("history");
  expect(exported).not.toHaveProperty("files");
  expect(imports).toBe(1);
  expect(downloads).toBe(1);
});

test("package import survives a committed reply loss and can be recovered explicitly from recent receipts", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await signup(
    page,
    `package-recovery-${Date.now()}@example.test`,
    "password12",
    "Package recovery",
  );
  await completeOnboarding(page);
  const before = await rpc<Bot[]>(page, "bots/list", {});
  let importCalls = 0;
  let accepted: BotPackageReceipt | null = null;
  let failRefresh = false;
  let refreshFailed = false;
  await page.route("**/rpc/spaces/list", async (route) => {
    if (!failRefresh) return route.fallback();
    failRefresh = false;
    refreshFailed = true;
    await route.abort("failed");
  });
  await page.route("**/rpc/botPackages/import", async (route) => {
    importCalls++;
    const response = await route.fetch({ maxRetries: 0 });
    expect(response.ok()).toBe(true);
    accepted = (await response.json()).json as BotPackageReceipt;
    await route.abort("failed");
  });
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("import-bot").click();
  const panel = page.getByTestId("bot-package-import");
  await panel.getByLabel("Bot package or Grok JSON", { exact: true }).fill(source);
  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  await panel.getByRole("button", { name: "Import as new bot", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Check status", exact: true })).toBeVisible();
  await expect(panel.getByLabel("Bot package or Grok JSON", { exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Resume import", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "d021-package-unknown");
  failRefresh = true;
  await panel.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(panel.getByText("Bot imported", { exact: true })).toBeVisible();
  await expect.poll(() => refreshFailed).toBe(true);
  await expect(panel.getByText("Bot imported", { exact: true })).toBeVisible();
  expect(importCalls).toBe(1);
  expect(await rpc<Bot[]>(page, "bots/list", {})).toHaveLength(before.length + 1);
  expect(accepted).not.toBeNull();
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("import-bot").click();
  await panel.getByRole("button", { name: "Recent imports", exact: true }).click();
  await panel
    .getByTestId("bot-package-recent")
    .getByRole("button", { name: "Review import", exact: true })
    .first()
    .click();
  await expect(panel.getByText("Bot imported", { exact: true })).toBeVisible();
  expect(importCalls).toBe(1);
  await captureScreenshot(page, testInfo, "d021-package-recovered");
});
