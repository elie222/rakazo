import { expect, test } from "@playwright/test";
import type { Routine, RoutineHistory } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  rpc,
  signup,
} from "./helpers";

test(
  "Korean webhook routine keeps technical field labels in English",
  { tag: "@nightly" },
  async ({ page }, testInfo) => {
    const stamp = Date.now();
    const userName = `Korean Routine ${stamp}`;
    await signup(page, `routine-ko-${stamp}@rakazo.test`, "password12", userName);
    await completeOnboarding(page);

    await page.getByRole("button", { name: new RegExp(userName) }).click();
    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByTestId("user-settings");
    await settings.getByTestId("ui-locale-select").click();
    await page.getByRole("option", { name: "한국어", exact: true }).click();
    await page.getByRole("button", { name: "계정 설정 닫기" }).click();

    await page.getByRole("button", { name: "Agent 컴퓨터", exact: true }).click();
    await page.getByRole("button", { name: "자동 실행 만들기" }).click();
    await page.getByPlaceholder("이 루틴의 이름을 정하세요").fill("한국어 웹훅 확인");
    await page
      .getByPlaceholder("이 루틴이 실행될 때마다 무엇을 해야 하나요?")
      .fill("웹훅을 확인합니다.");
    await page.getByRole("button", { name: "트리거 추가" }).click();
    await page.getByRole("menuitem", { name: "웹훅", exact: true }).click();

    await expect(page.getByText("웹훅이 실행될 때", { exact: true })).toBeVisible();
    await expect(page.getByText("POST 대상")).toBeVisible();
    await expect(page.getByText("key", { exact: true })).toBeVisible();
    await expect(page.getByText("header")).toBeVisible();
    await captureScreenshot(page, testInfo, "routine-webhook-ko");
  },
);

test("routine test-run completes and survives reload", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-${stamp}@rakazo.test`, "password12", "Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await openBotPanelTab(page, "Routines");
  await expect(page.getByRole("button", { name: "Test run" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Daily verification");
  await page
    .locator("label:has-text('Instruction') textarea")
    .fill("write routine-run-now-ok into the durable task result");
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: "Weekdays", exact: true }).click();
  await expect(page.getByLabel("How often")).toHaveValue("Weekdays");
  await captureScreenshot(page, testInfo, "32-routine-configured");

  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  await page.getByRole("button", { name: "Save" }).click();
  await saved;
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
  const routine = page.getByRole("button", { name: /Daily verification/ });
  await expect(routine).toContainText("Weekdays at 9:00 AM");
  await captureScreenshot(page, testInfo, "33-routine-scheduled");

  await routine.click();
  const created = (await rpc<Routine[]>(page, "routines/list", { botId })).find(
    (item) => item.name === "Daily verification",
  );
  const runs = async () =>
    (await rpc<RoutineHistory>(page, "routines/history", { routineId: created?.id })).runs;
  await page.getByRole("button", { name: "Test run" }).click();
  // The open editor's instruction already shows the marker text, so wait on the run itself
  // and read the marker from the bot reply the run recorded.
  await expect
    .poll(async () => (await runs()).map((run) => run.status), { timeout: 30_000 })
    .toEqual(["completed"]);
  const messageId = (await runs())[0]?.messageId;
  expect(messageId).toBeTruthy();
  const reply = page
    .getByTestId("transcript")
    .locator(`[data-message-id="${messageId}"]`)
    .getByTestId("message-bot-bubble");
  await expect(reply).toBeVisible();
  await expect(reply).toContainText(/routine-run-now-ok/i);
  await captureScreenshot(page, testInfo, "34-routine-run-completed");

  await page.reload();
  await expect(reply).toBeVisible();
  await expect(reply).toContainText(/routine-run-now-ok/i);
  await openBotPanelTab(page, "Routines");
  await expect(page.getByRole("button", { name: /Daily verification/ })).toContainText(
    "Weekdays at 9:00 AM",
  );
  await page.getByRole("button", { name: /Daily verification/ }).click();
  const history = page.getByTestId("routine-run-history");
  await expect(history.getByTestId("routine-run-row")).toHaveCount(1);
  expect((await runs()).map((run) => run.status)).toEqual(["completed"]);
  await expect(history.getByText("No runs yet")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "36-routine-run-history");
  await history.getByTestId("routine-run-row").getByRole("link").click();
  await expect(reply).toBeVisible();
  await expect(reply).toContainText(/routine-run-now-ok/i);
  await captureScreenshot(page, testInfo, "35-routine-run-persisted");
});

test("a routine run that failed to start shows the error in Details", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-failed-${stamp}@rakazo.test`, "password12", "Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Nightly check",
    prompt: "Check the site",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: false,
    notify: false,
  });
  // The e2e stack runs no supervisor egress probe. A real run stores what the Docker provider
  // throws for the supervisor's 500 response, so the history response carries that form.
  const message =
    "No SANDBOX_COMPUTER_DNS server answered from a restricted computer network; set servers reachable from there, such as public resolvers (see docs/self-host-docker-computers.md)";
  const error = `sandbox provision failed: 500 ${JSON.stringify({ error: message })}`;
  const at = new Date().toISOString();
  await page.route("**/rpc/routines/history", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          runs: [
            {
              id: `run-${stamp}`,
              botId,
              groupId: null,
              status: "failed",
              error,
              createdAt: at,
              startedAt: at,
              completedAt: at,
              messageId: null,
            },
          ],
          nextCursor: null,
        },
      }),
    }),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  // Details then opens without the slide transition, so the capture shows the whole error.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await openBotPanelTab(page, "Routines");
  await page.getByRole("button", { name: /Nightly check/ }).click();
  const history = page.getByTestId("routine-run-history");
  await history.getByText("Details", { exact: true }).click();
  await expect(history.locator("pre")).toHaveText(error);
  await captureScreenshot(page, testInfo, "routine-run-computer-dns-error");
});

test("run history links runs that replied and marks silent ones", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-states-${stamp}@rakazo.test`, "password12", "Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Price watch",
    prompt: "Only message me when the price drops",
    crons: ["0 * * * *"],
    timezone: "UTC",
    active: false,
    notify: false,
  });
  const minute = 60_000;
  const run = (index: number, status: string, extra: Record<string, unknown> = {}) => {
    const at = new Date(Date.now() - index * 60 * minute).toISOString();
    return {
      id: `run-${stamp}-${index}`,
      botId,
      groupId: null,
      status,
      error: null,
      createdAt: at,
      startedAt: at,
      completedAt: status === "running" ? null : at,
      messageId: null,
      ...extra,
    };
  };
  await page.route("**/rpc/routines/history", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          runs: [
            run(0, "running"),
            run(1, "completed", { messageId: `message-${stamp}` }),
            run(2, "completed"),
            run(3, "failed", { error: "504: request timed out" }),
            run(4, "completed"),
          ],
          nextCursor: null,
        },
      }),
    }),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await openBotPanelTab(page, "Routines");
  await page.getByRole("button", { name: /Price watch/ }).click();
  const history = page.getByTestId("routine-run-history");
  await expect(history.getByRole("heading", { name: "Run history" })).toBeVisible();
  const rows = history.getByTestId("routine-run-row");
  await expect(rows).toHaveCount(5);
  await expect(history.getByRole("link")).toHaveCount(1);
  await expect(rows.nth(1).getByRole("link")).toHaveAttribute(
    "href",
    `/app/${botId}?m=message-${stamp}`,
  );
  await expect(history.getByText("No reply", { exact: true })).toHaveCount(2);
  await history.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "routine-run-history-states");
});
