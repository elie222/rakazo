import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

test("clicking inside the composer border focuses the message field", async ({
  page,
}, testInfo) => {
  await signup(page, `composer-focus-${Date.now()}@rakazo.test`, "password12", "Composer Tester");
  await completeOnboarding(page);
  const field = page.getByRole("combobox", { name: /^Message/ });
  const bar = page.getByTestId("composer-bar");
  const send = bar.getByRole("button", { name: "Send" });
  await expect(field).toBeVisible();
  await expect(send).toBeDisabled();
  await field.blur();

  const barBox = await bar.boundingBox();
  const fieldBox = await field.boundingBox();
  const sendBox = await send.boundingBox();
  if (!barBox || !fieldBox || !sendBox) throw new Error("Composer is not visible");
  await page.mouse.click(sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2);
  await expect(field).not.toBeFocused();

  const fieldCenterX = fieldBox.x + fieldBox.width / 2;
  await page.mouse.click(fieldCenterX, barBox.y + 4);
  await expect(field).toBeFocused();
  await page.mouse.click(fieldCenterX, barBox.y + barBox.height - 4);
  await expect(field).toBeFocused();

  await field.blur();
  await page.mouse.click(fieldBox.x + fieldBox.width + 4, fieldBox.y + fieldBox.height / 2);
  await expect(field).toBeFocused();
  await captureScreenshot(page, testInfo, "composer-focus");
});
