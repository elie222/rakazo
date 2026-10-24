import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, rpc, signup } from "./helpers";

/** Onboarding shows the model step only while the account needs a model; tests decide when. */
async function controlNeedsModel(page: Page) {
  const state = { needsModel: true };
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: state.needsModel } },
    });
  });
  return state;
}

test("a new user can start from an imported agent instead of Chief", async ({ page }, testInfo) => {
  const model = await controlNeedsModel(page);
  await signup(page, `onboarding-import-${Date.now()}@rakazo.test`, "password12", "Importer");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
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

  // The import's own connection (here: the deployment's) completes the model step.
  model.needsModel = false;
  await preview.getByRole("button", { name: "Create", exact: true }).click();
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
  await expect(page.getByRole("button", { name: "Import an agent", exact: true })).toBeVisible();
  // Connecting a model elsewhere, then continuing, makes Chief exactly as before.
  model.needsModel = false;
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.map((bot) => bot.name)).toEqual(["Chief"]);
  await captureScreenshot(page, testInfo, "onboarding-chief-without-import");
});
