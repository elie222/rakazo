import { expect, test } from "@playwright/test";
import type { Routine } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

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

  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
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
  await page.getByRole("button", { name: "Test run" }).click();
  await expect(page.getByText(/routine-run-now-ok/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "34-routine-run-completed");

  await page.reload();
  await expect(page.getByText(/routine-run-now-ok/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  await expect(page.getByRole("button", { name: /Daily verification/ })).toContainText(
    "Weekdays at 9:00 AM",
  );
  await page.getByRole("button", { name: /Daily verification/ }).click();
  const history = page.getByTestId("routine-run-history");
  await expect(history.getByTestId("routine-run-row")).toHaveCount(1);
  const created = (await rpc<Routine[]>(page, "routines/list", { botId })).find(
    (item) => item.name === "Daily verification",
  );
  const ran = await rpc<{ runs: Array<{ status: string }> }>(page, "routines/history", {
    routineId: created?.id,
  });
  expect(ran.runs.map((run) => run.status)).toEqual(["completed"]);
  await expect(history.getByText("No runs yet")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "36-routine-run-history");
  await history.getByTestId("routine-run-row").getByRole("link").click();
  await expect(page.getByText(/routine-run-now-ok/i).first()).toBeVisible();
  await captureScreenshot(page, testInfo, "35-routine-run-persisted");
});
