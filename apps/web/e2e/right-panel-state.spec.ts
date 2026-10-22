import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, Routine } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function waitForStoredPanel(page: Page, panel: string | null) {
  await expect
    .poll(async () => {
      return page.evaluate((expected) => {
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (!key?.includes("rakazo:right-panel-state:")) continue;
          try {
            const value = JSON.parse(localStorage.getItem(key) ?? "null") as { panel?: unknown };
            if (value && "panel" in value && value.panel === expected) return true;
          } catch {
            // ignore malformed entries while waiting for the write effect
          }
        }
        return false;
      }, panel);
    })
    .toBe(true);
}

test("reload restores the open, closed and settings rail states", async ({ page }, testInfo) => {
  await signup(page, `rail-state-${Date.now()}@rakazo.test`, "password12", "Panel Layout");
  await completeOnboarding(page);
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  await expect(panel).toHaveAttribute("data-panel", "computer");
  await waitForStoredPanel(page, "computer");
  await page.reload();
  await expect(panel).toHaveAttribute("data-panel", "computer");
  await expect(page.getByTestId("computer-preview")).toBeVisible();
  await captureScreenshot(page, testInfo, "rail-restored-after-reload");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await waitForStoredPanel(page, null);
  await page.reload();
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await expect(panel).toHaveCSS("width", "0px");
  let releaseBootstrap!: () => void;
  const bootstrapReady = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    await bootstrapReady;
    await route.fulfill({ response });
  });
  await page.reload();
  await page.getByTestId("bot-settings-trigger").click();
  const bootstrapResponse = page.waitForResponse("**/rpc/bootstrap");
  releaseBootstrap();
  await bootstrapResponse;
  await page.unrouteAll({ behavior: "wait" });
  await expect(panel).toHaveAttribute("data-panel", "settings");
  await waitForStoredPanel(page, "settings");
  await page.reload();
  await expect(panel).toHaveAttribute("data-panel", "settings");
});

test("reload restores the selected routine and scopes preferences to the chat", async ({
  page,
}, testInfo) => {
  await signup(page, `rail-routine-${Date.now()}@rakazo.test`, "password12", "Routine Layout");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const routine = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Weekly summary",
    prompt: "Summarize the week",
    crons: ["0 9 * * 1"],
    timezone: "UTC",
    active: false,
  });
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  await page.getByRole("button", { name: /Weekly summary/ }).click();
  const name = page.locator("label:has-text('Name') input");
  await expect(name).toHaveValue("Weekly summary");
  await waitForStoredPanel(page, "routine");
  await page.reload();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "routine");
  await expect(name).toHaveValue("Weekly summary");
  await captureScreenshot(page, testInfo, "rail-restored-routine");

  const other = await rpc<Bot>(page, "bots/create", {
    name: "Other chat",
    description: "Test layout separation",
  });
  await page.goto(`/app/${other.id}`);
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
  await page.goto(`/app/${botId}`);
  await expect(name).toHaveValue("Weekly summary");
  // A cold deep link wins even when bootstrap delivers the bot and routines together.
  await page.goto(`/app/${botId}?routine=${routine.id}`);
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "routine");
  await expect(name).toHaveValue("Weekly summary");
  await expect(page).not.toHaveURL(/routine=/);
  await page.reload();
  await expect(name).toHaveValue("Weekly summary");

  // Explicit navigation cancels a routine link whose list is still loading.
  let releaseRoutines!: () => void;
  const routinesReady = new Promise<void>((resolve) => {
    releaseRoutines = resolve;
  });
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.json.thread = null;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/routines/list", async (route) => {
    const response = await route.fetch();
    await routinesReady;
    await route.fulfill({ response });
  });
  await page.goto(`/app/${botId}?routine=${routine.id}`);
  await page.getByTestId("bot-settings-trigger").click();
  await expect(page).not.toHaveURL(/routine=/);
  const listResponse = page.waitForResponse("**/rpc/routines/list");
  releaseRoutines();
  await listResponse;
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "settings");
  await waitForStoredPanel(page, "settings");
  await page.reload();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "settings");

  // Editing another chat must beat its saved routine panel.
  const originalName = await rpc<Bot>(page, "bots/get", { botId }).then((bot) => bot.name);
  await page.goto(`/app/${other.id}`);
  await page
    .getByRole("button", { name: originalName, exact: false })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit Profile", exact: true }).click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "settings");
  await waitForStoredPanel(page, "settings");
  await page.reload();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "settings");
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  await page.getByRole("button", { name: /Weekly summary/ }).click();
  await rpc(page, "routines/remove", { routineId: routine.id });
  await page.reload();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "computer");
  await expect(page.getByRole("button", { name: /Weekly summary/ })).toHaveCount(0);
});
