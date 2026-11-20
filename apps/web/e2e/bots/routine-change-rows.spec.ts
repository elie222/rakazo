import { expect, test } from "@playwright/test";
import type { Routine } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanel,
  rpc,
  signup,
} from "../helpers/helpers";

test("routine changes leave one-line rows in the chat", async ({ page }, testInfo) => {
  await signup(page, `routine-rows-${Date.now()}@rakazo.test`, "password12", "Routine rows");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const rows = page.getByTestId("routine-event-row");

  const routine = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Morning joke",
    prompt: "Tell a joke. SECRET PROMPT",
    crons: ["0 8 * * *"],
    timezone: "UTC",
    active: true,
  });
  await expect(rows).toHaveText(['Created routine "Morning joke"']);

  await openBotPanel(page);
  const toggle = page.getByRole("switch", { name: "Turn Morning joke on or off" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(rows.last()).toHaveText('Disabled routine "Morning joke"');
  await toggle.click();
  await expect(rows.last()).toHaveText('Enabled routine "Morning joke"');

  await rpc(page, "routines/update", { routineId: routine.id, name: "Evening joke" });
  await expect(rows.last()).toHaveText('Updated routine "Evening joke"');

  await rpc(page, "routines/remove", { routineId: routine.id });
  await expect(rows.last()).toHaveText('Deleted routine "Evening joke"');
  await expect(rows).toHaveText([
    'Created routine "Morning joke"',
    'Disabled routine "Morning joke"',
    'Enabled routine "Morning joke"',
    'Updated routine "Evening joke"',
    'Deleted routine "Evening joke"',
  ]);
  // The row names the routine and nothing else.
  await expect(page.getByText("SECRET PROMPT")).toHaveCount(0);

  // A reload shows the same rows from the saved chat.
  await page.reload();
  await expect(rows).toHaveCount(5);
  await captureScreenshot(page, testInfo, "routine-change-rows");
});
