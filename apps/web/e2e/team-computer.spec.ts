import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";

test("opening and releasing the computer keep a view-only stream; a failed release can be retried", async ({
  page,
}, testInfo) => {
  await signup(page, `view-only-${Date.now()}@rakazo.test`, "password12", "Computer");
  await completeOnboarding(page);
  let takeovers = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/computer/takeover")) takeovers += 1;
  });
  await openComputerPanel(page);
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  const chrome = page.getByTestId("computer-chrome");
  const screen = page.getByTitle("Bot screen").last();
  const take = chrome.getByRole("button", { name: "Take control", exact: true });
  const release = chrome.getByRole("button", { name: "Release control", exact: true });
  const more = chrome.getByRole("button", { name: "More computer actions" });
  // The overlay covers the conversation header, which drags the desktop window.
  await expect(chrome).toHaveCSS("-webkit-app-region", "no-drag");
  const checkViewOnly = async () => {
    await expect(take).toBeVisible();
    await expect(release).toHaveCount(0);
    await expect(screen).toHaveAttribute("src", /view_only=true/);
    await expect(screen).toHaveCSS("pointer-events", "none");
    await more.click();
    await expect(page.getByRole("menuitem", { name: "Recover computer" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Reset computer" })).toBeVisible();
    await more.click();
  };
  await checkViewOnly();
  expect(takeovers).toBe(0);
  await captureScreenshot(page, testInfo, "computer-open-view-only");
  await take.click();
  await expect(release).toBeVisible();
  await expect(take).toHaveCount(0);
  await expect(screen).toHaveAttribute("src", /view_only=false/);
  await expect(screen).toHaveCSS("pointer-events", "auto");
  expect(takeovers).toBe(1);
  await more.click();
  await expect(page.getByRole("menuitem", { name: "Recover computer" })).toBeVisible();
  await more.click();
  await captureScreenshot(page, testInfo, "computer-controlling");
  await release.click();
  await checkViewOnly();
  expect(takeovers).toBe(1);
  await captureScreenshot(page, testInfo, "computer-released-view-only");

  // A release that fails keeps the computer open so it can be retried.
  await take.click();
  await expect(release).toBeVisible();
  await page.route("**/rpc/computer/release", (route) =>
    route.fulfill({ status: 500, body: "release unavailable" }),
  );
  await release.click();
  await expect(page.getByText("Could not continue", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await captureScreenshot(page, testInfo, "48-team-computer-release-retry");
  await page.unroute("**/rpc/computer/release");
  await release.click();
  await expect(take).toBeVisible();
  await chrome.getByRole("button", { name: "Close computer" }).click();
  await expect(chrome).toBeHidden();
});

test("an active Team bot must be stopped before user takeover", async ({ page }, testInfo) => {
  const stamp = Date.now();

  await signup(
    page,
    `active-team-control-${stamp}@rakazo.test`,
    "password12",
    "Active Team Control",
  );
  await completeOnboarding(page);
  const chiefId = activeBotId(page);

  await sendMessage(page, "keep working until I stop you");
  await expect
    .poll(async () => (await threadSnapshot(page, chiefId)).run?.status ?? "idle")
    .toBe("running");
  await captureScreenshot(page, testInfo, "48-active-team-bot-blocks-takeover");
  await expect
    .poll(
      async () => (await rpc<{ state: string }>(page, "computer/status", { botId: chiefId })).state,
    )
    .toBe("running");
  await expect
    .poll(
      async () =>
        (
          await rpc<{ busyBotName: string | null }>(page, "computer/status", {
            botId: chiefId,
          })
        ).busyBotName,
    )
    .not.toBeNull();

  const takeover = await rpcResponse(page, "computer/takeover", { botId: chiefId });
  expect(takeover.ok).toBe(false);
  expect(takeover.status).toBe(409);
  await expect
    .poll(async () => (await threadSnapshot(page, chiefId)).run?.status ?? "idle")
    .toBe("running");

  await openBotPanelTab(page, "Computer");
  const sidePanel = page.getByTestId("side-panel");
  await expect(sidePanel.getByRole("button", { name: /Take control/i })).toHaveCount(0);
  await page.getByTestId("computer-preview").hover();
  const openBusy = sidePanel.getByTestId("computer-preview-open");
  await expect(openBusy).toBeVisible();
  await expect(openBusy.getByText("Open", { exact: true })).toBeVisible();
  await openBusy.click();
  const chrome = page.getByTestId("computer-chrome");
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  // Open while the bot is busy must not grant control (takeover stays blocked).
  await expect(chrome.getByText("You have control", { exact: true })).toHaveCount(0);
  await expect(chrome.getByRole("button", { name: /Take control/i })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "48b-open-while-busy-no-control");
  await page.getByRole("button", { name: "Close computer" }).click();

  // Stop through the shell so the client refreshes computer status (API stop alone
  // does not emit a terminal thread event).
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await waitForIdle(page, chiefId);
  await expect
    .poll(
      async () =>
        (
          await rpc<{ busyBotName: string | null }>(page, "computer/status", {
            botId: chiefId,
          })
        ).busyBotName,
    )
    .toBeNull();

  // After stop, opening stays view-only until Take control is clicked.
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(chrome.getByText("You have control", { exact: true })).toHaveCount(0);
  await chrome.getByRole("button", { name: "Take control", exact: true }).click();
  await expect(chrome.getByText("You have control", { exact: true })).toBeVisible();
  await expect(chrome.getByRole("button", { name: "Release control", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "49-team-computer-open-after-stop");
  await chrome.getByRole("button", { name: "Release control", exact: true }).click();
  await expect(chrome.getByRole("button", { name: "Take control", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
});

async function openComputerPanel(page: Page) {
  await openBotPanelTab(page, "Computer");
  await expect(page.getByTestId("computer-preview")).toBeVisible();
  await expect(page.getByTestId("computer-preview-open")).toHaveCount(1);
}

async function sendMessage(page: Page, text: string) {
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(text);
  const sent = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/threads/send") && response.request().method() === "POST",
  );
  await page.keyboard.press("Enter");
  const response = await sent;
  expect(response.ok()).toBe(true);
  const result = (await response.json()) as { json?: { runId?: string } };
  if (!result.json?.runId) throw new Error("threads/send did not return a run id");
  return result.json.runId;
}

async function waitForIdle(page: Page, botId: string) {
  await expect
    .poll(async () => (await threadSnapshot(page, botId)).run?.status ?? "idle", {
      timeout: realSandboxTimeout(90_000, 20_000),
    })
    .toBe("idle");
}

function threadSnapshot(page: Page, botId: string) {
  return rpc<{
    run: { id: string; status: string } | null;
    messages: Array<{ runId?: string | null }>;
  }>(page, "threads/get", { botId });
}

async function rpcResponse(page: Page, procedure: string, body: unknown) {
  const response = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  return { ok: response.ok(), status: response.status() };
}
