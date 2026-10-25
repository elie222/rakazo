import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, clickAndWaitForRpc, rpc, signup } from "./helpers";

/** Onboarding shows the model step only while the account needs a model; tests decide when. */
async function controlNeedsModel(page: Page, { survey = false } = {}) {
  const state = { needsModel: true };
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: state.needsModel, needsSignupSurvey: survey } },
    });
  });
  return state;
}

test("a new user can start from an imported agent instead of Chief", async ({ page }, testInfo) => {
  const model = await controlNeedsModel(page, { survey: true });
  await signup(page, `onboarding-import-${Date.now()}@rakazo.test`, "password12", "Importer");
  await expect(page.getByRole("heading", { name: "Welcome to Rakazo" })).toBeVisible({
    timeout: 20_000,
  });
  const entry = page.getByRole("button", { name: "Import an agent", exact: true });
  await expect(entry).toBeVisible();
  await captureScreenshot(page, testInfo, "onboarding-import-entry");

  await entry.click();
  const panel = page.getByTestId("agent-import");
  await expect(panel.getByTestId("agent-import-choose")).toBeVisible();
  await captureScreenshot(page, testInfo, "onboarding-import-choose");

  const broken = testInfo.outputPath("broken.zip");
  writeFileSync(broken, Buffer.from("PK not really a zip"));
  await panel.getByTestId("agent-import-archive").setInputFiles(broken);
  await expect(panel.getByRole("alert")).toHaveText("This backup could not be read.");
  await captureScreenshot(page, testInfo, "onboarding-import-error");

  const home = testInfo.outputPath("openclaw-home");
  for (const [file, content] of Object.entries({
    "openclaw.json": `{
      agents: { defaults: { model: { primary: "deepseek/deepseek-flash" } } },
      mcp: { servers: { docs: { url: "https://mcp.example.com/mcp" } } },
    }`,
    ".env": "DEEPSEEK_API_KEY=placeholder-deepseek-key\n",
    "workspace/SOUL.md": "Calm and direct.\n",
    "workspace/IDENTITY.md": "- **Name:** Pebble\n",
    "cron/jobs.json": JSON.stringify({
      jobs: [
        {
          name: "morning",
          schedule: { kind: "cron", expr: "0 9 * * *" },
          payload: { kind: "agentTurn", message: "Summarise my day" },
        },
      ],
    }),
  })) {
    mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    writeFileSync(path.join(home, file), content);
  }
  await panel.getByTestId("agent-import-folder").setInputFiles(home);
  const preview = panel.getByTestId("agent-import-preview");
  await expect(preview.getByRole("textbox", { name: "Name" })).toHaveValue("Pebble");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "onboarding-import-preview");

  // The model needs its provider's key: unusable until the key is included.
  const modelBox = preview
    .getByTestId("agent-import-model")
    .getByRole("checkbox", { name: "deepseek/deepseek-flash", exact: true });
  await expect(modelBox).toBeDisabled();
  await preview.getByRole("checkbox", { name: "Include API keys" }).click();
  await expect(
    preview
      .getByTestId("agent-import-keys")
      .getByRole("checkbox", { name: "DeepSeek", exact: true }),
  ).toBeChecked();
  await expect(modelBox).toBeEnabled();
  await expect(preview.getByTestId("agent-import-mcp")).toBeVisible();
  await expect(preview.getByTestId("agent-import-routines")).toBeVisible();
  await captureScreenshot(page, testInfo, "onboarding-import-preview-settings");
  // The placeholder key cannot be verified offline, so it is left out of this import.
  await preview.getByRole("checkbox", { name: "Include API keys" }).click();
  await expect(
    preview
      .getByTestId("agent-import-keys")
      .getByRole("checkbox", { name: "DeepSeek", exact: true }),
  ).toHaveCount(0);

  // The import's own connection (here: the deployment's) skips the model step.
  model.needsModel = false;
  await clickAndWaitForRpc(
    page,
    preview.getByRole("button", { name: "Create", exact: true }),
    "bots/importCreate",
  );
  await expect(page.getByRole("heading", { name: "Welcome to Rakazo" })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByPlaceholder("Message Pebble")).toBeVisible();
  const botId = activeBotId(page);
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.map((bot) => [bot.id, bot.name])).toEqual([[botId, "Pebble"]]);
  await captureScreenshot(page, testInfo, "onboarding-import-done");
});

test("a new user who ignores import still starts with Chief", async ({ page }, testInfo) => {
  const model = await controlNeedsModel(page);
  await signup(page, `onboarding-no-import-${Date.now()}@rakazo.test`, "password12", "Plain");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
    timeout: 20_000,
  });
  // Connecting a model is the one thing this step asks for.
  await expect(page.getByRole("button", { name: "Import an agent", exact: true })).toHaveCount(0);
  // Connecting a model elsewhere, then opening onboarding again, makes Chief exactly as
  // before. (A linked /onboarding/model stays on the model step on purpose.)
  model.needsModel = false;
  await page.goto("/onboarding");
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.map((bot) => bot.name)).toEqual(["Chief"]);
  await captureScreenshot(page, testInfo, "onboarding-chief-without-import");
});

test("with a model already provided, import is offered before the first bot is made", async ({
  page,
}, testInfo) => {
  // A deployment that provides the model: no model step, only the sign-up survey.
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: false, needsSignupSurvey: true } },
    });
  });
  await signup(page, `onboarding-import-ready-${Date.now()}@rakazo.test`, "password12", "Ready");
  await expect(page.getByRole("heading", { name: "Welcome to Rakazo" })).toBeVisible({
    timeout: 20_000,
  });
  // No bot is made while the user is still choosing.
  expect(await rpc<Bot[]>(page, "bots/list", {})).toEqual([]);
  const entry = page.getByRole("button", { name: "Import an agent", exact: true });
  await expect(entry).toBeVisible();
  await captureScreenshot(page, testInfo, "onboarding-import-entry-no-model-step");

  await entry.click();
  const panel = page.getByTestId("agent-import");
  const home = testInfo.outputPath("openclaw-ready");
  mkdirSync(path.join(home, "workspace"), { recursive: true });
  writeFileSync(path.join(home, "workspace/SOUL.md"), "Calm.\n");
  writeFileSync(path.join(home, "workspace/IDENTITY.md"), "- **Name:** Pebble\n");
  await panel.getByTestId("agent-import-folder").setInputFiles(home);
  await clickAndWaitForRpc(
    page,
    panel.getByRole("button", { name: "Create", exact: true }),
    "bots/importCreate",
  );
  // The survey still comes first; its Continue opens the imported bot, and no Chief is made.
  await expect(page.getByRole("heading", { name: "Welcome to Rakazo" })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByPlaceholder("Message Pebble")).toBeVisible();
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.map((bot) => bot.name)).toEqual(["Pebble"]);
});

test("with a model already provided, an import that finds a first bot already made says so and the survey goes on to it", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: false, needsSignupSurvey: true } },
    });
  });
  await signup(
    page,
    `onboarding-import-raced-ready-${Date.now()}@rakazo.test`,
    "password12",
    "Raced",
  );
  await expect(page.getByRole("heading", { name: "Welcome to Rakazo" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Import an agent", exact: true }).click();
  const home = testInfo.outputPath("openclaw-raced-ready");
  mkdirSync(path.join(home, "workspace"), { recursive: true });
  writeFileSync(path.join(home, "workspace/SOUL.md"), "Calm.\n");
  writeFileSync(path.join(home, "workspace/IDENTITY.md"), "- **Name:** Pebble\n");
  const panel = page.getByTestId("agent-import");
  await panel.getByTestId("agent-import-folder").setInputFiles(home);
  const preview = panel.getByTestId("agent-import-preview");
  await expect(preview.getByRole("textbox", { name: "Name" })).toHaveValue("Pebble");
  // Another tab or device finishes onboarding first.
  const chief = await rpc<Bot>(page, "bots/create", {
    name: "Chief",
    spawnKey: "onboarding:first",
  });
  await preview.getByRole("button", { name: "Create", exact: true }).click();
  const notice = page.getByTestId("onboarding-not-imported");
  await expect(notice.getByRole("alert")).toHaveText(
    "Your first bot already existed, so the agent was not imported.",
  );
  // The survey's own Continue is the one way on.
  await expect(page.getByRole("heading", { name: "Welcome to Rakazo" })).toBeVisible();
  await expect(notice.getByRole("button")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "onboarding-import-not-imported-survey");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL(new RegExp(`/app/${chief.id}$`), { timeout: 20_000 });
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.map((bot) => bot.name)).toEqual(["Chief"]);
});

test("with a model already provided, ignoring import still starts with Chief at once", async ({
  page,
}) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: false, needsSignupSurvey: true } },
    });
  });
  await signup(page, `onboarding-no-import-ready-${Date.now()}@rakazo.test`, "password12", "Plain");
  await expect(page.getByRole("heading", { name: "Welcome to Rakazo" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
});

/** A self-hosted deployment that provides the model: no model step and no sign-up survey. */
async function noOnboardingSteps(page: Page) {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: false, needsSignupSurvey: false } },
    });
  });
}

// Chief's fixed focus card is posted only when Chief has no intro run (the scripted test
// runtime, or no model when Chief was made); otherwise Chief's intro asks what it is for.
test("with no onboarding steps and no intro run, Chief's focus card offers import into a new bot", async ({
  page,
}, testInfo) => {
  await noOnboardingSteps(page);
  await signup(page, `onboarding-import-chief-${Date.now()}@rakazo.test`, "password12", "Host");
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
  const [chief] = await rpc<Bot[]>(page, "bots/list", {});
  const before = await rpc<Bot>(page, "bots/get", { botId: chief!.id });
  const card = page
    .getByText("What do you want me on first?", { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'bg-card')][1]");
  const entry = card.getByRole("button", { name: "Import an agent", exact: true });
  await expect(entry).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, testInfo, "onboarding-import-chief-focus-card");

  await entry.click();
  const panel = page.getByTestId("agent-import");
  const home = testInfo.outputPath("openclaw-chief");
  mkdirSync(path.join(home, "workspace"), { recursive: true });
  writeFileSync(path.join(home, "workspace/SOUL.md"), "Calm.\n");
  writeFileSync(path.join(home, "workspace/IDENTITY.md"), "- **Name:** Pebble\n");
  await panel.getByTestId("agent-import-folder").setInputFiles(home);
  const preview = panel.getByTestId("agent-import-preview");
  // A new bot, as everywhere else; Chief is offered only if the user picks it.
  await expect(
    preview.getByTestId("agent-import-destination").getByRole("button", { name: "New bot" }),
  ).toHaveAttribute("aria-pressed", "true");
  await clickAndWaitForRpc(
    page,
    preview.getByRole("button", { name: "Create", exact: true }),
    "bots/importCreate",
  );
  await expect(page.getByPlaceholder("Message Pebble")).toBeVisible();
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.map((bot) => bot.name).sort()).toEqual(["Chief", "Pebble"]);
  const after = await rpc<Bot>(page, "bots/get", { botId: chief!.id });
  expect(after.instructions).toBe(before.instructions);
});

test("with no onboarding steps and no intro run, ignoring import changes nothing and the offer ends with first run", async ({
  page,
}) => {
  await noOnboardingSteps(page);
  await signup(
    page,
    `onboarding-import-chief-skip-${Date.now()}@rakazo.test`,
    "password12",
    "Skip",
  );
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
  const card = page
    .getByText("What do you want me on first?", { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'bg-card')][1]");
  await expect(card.getByRole("button", { name: "Import an agent", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  expect((await rpc<Bot[]>(page, "bots/list", {})).map((bot) => bot.name)).toEqual(["Chief"]);
  // Answering the first-run question ends the offer, like the card's own choices.
  await card.getByRole("button", { name: /Inbox & email/ }).click();
  await expect(card.getByRole("button", { name: "Import an agent", exact: true })).toHaveCount(0);
  expect((await rpc<Bot[]>(page, "bots/list", {})).map((bot) => bot.name)).toEqual(["Chief"]);
});
