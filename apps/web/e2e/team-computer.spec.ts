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

test("opening the computer takes control at once; I'm done or closing hands it back", async ({
  page,
}, testInfo) => {
  await signup(page, `control-${Date.now()}@rakazo.test`, "password12", "Computer");
  await completeOnboarding(page);
  let takeovers = 0;
  let releases = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/computer/takeover")) takeovers += 1;
    if (request.url().endsWith("/rpc/computer/release")) releases += 1;
  });
  await openComputerPanel(page);
  await captureScreenshot(page, testInfo, "computer-tab-asleep");
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  const chrome = page.getByTestId("computer-chrome");
  const screen = page.getByTitle("Bot screen").last();
  const pill = page.getByTestId("computer-control-pill");
  const done = pill.getByRole("button", { name: "I’m done", exact: true });
  const more = chrome.getByRole("button", { name: "More computer actions" });
  // The overlay covers the conversation header, which drags the desktop window.
  await expect(chrome).toHaveCSS("-webkit-app-region", "no-drag");
  const checkInControl = async () => {
    await expect(pill).toContainText("You’re in control");
    await expect(screen).toHaveAttribute("src", /view_only=false/);
    await expect(screen).toHaveCSS("pointer-events", "auto");
    await expect(page.getByRole("button", { name: "Take control" })).toHaveCount(0);
  };
  await checkInControl();
  expect(takeovers).toBe(1);
  await more.click();
  await expect(page.getByRole("menuitem", { name: "Recover computer" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Reset computer" })).toBeVisible();
  await more.click();
  await captureScreenshot(page, testInfo, "computer-controlling");

  await done.click();
  await expect(chrome).toBeHidden();
  expect(releases).toBe(1);
  await expect(page.getByTitle("Bot screen preview")).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-tab-running");

  // Closing the window hands control back too.
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  await checkInControl();
  await chrome.getByRole("button", { name: "Close computer" }).click();
  await expect(chrome).toBeHidden();
  await expect.poll(() => releases).toBe(2);

  // A release that fails keeps the computer open so it can be retried.
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  await checkInControl();
  await page.route("**/rpc/computer/release", (route) =>
    route.fulfill({ status: 500, body: "release unavailable" }),
  );
  await done.click();
  await expect(page.getByText("Could not continue", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await captureScreenshot(page, testInfo, "48-team-computer-release-retry");
  await page.unroute("**/rpc/computer/release");
  await page.getByRole("button", { name: "Retry screen" }).click();
  await done.click();
  await expect(chrome).toBeHidden();
});

test("a working Team bot keeps the screen until its run ends, then the open window takes control", async ({
  page,
}, testInfo) => {
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
  await page.getByTestId("computer-preview").hover();
  const openBusy = sidePanel.getByTestId("computer-preview-open");
  await expect(openBusy).toBeVisible();
  await expect(openBusy.getByText("Open", { exact: true })).toBeVisible();
  await openBusy.click();
  const pill = page.getByTestId("computer-control-pill");
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  // The bot's run keeps the screen; the window only watches it.
  await expect(pill).toHaveText(/is working$/);
  await expect(pill.getByRole("button")).toHaveCount(0);
  await expect(page.getByTitle("Bot screen").last()).toHaveCSS("pointer-events", "none");
  await captureScreenshot(page, testInfo, "48b-open-while-busy-no-control");

  // Stopping the run hands the screen to the open window.
  await page.getByTestId("computer-overlay-stop").click();
  await waitForIdle(page, chiefId);
  await expect(pill).toContainText("You’re in control");
  await expect(page.getByTitle("Bot screen").last()).toHaveCSS("pointer-events", "auto");
  await captureScreenshot(page, testInfo, "49-team-computer-open-after-stop");
  await pill.getByRole("button", { name: "I’m done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeHidden();
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
