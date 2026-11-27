import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

test("the chat shows the submitted feedback receipt", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/gallery.html?scenario=feedback&theme=light");

  const receipt = page.getByTestId("feedback-receipt");
  await expect(receipt.getByText("Bug report sent")).toBeVisible();
  await expect(receipt.getByText("The preview stayed blank after I opened a file.")).toBeVisible();
  await expect(receipt.getByText("Receipt example-report-1")).toBeVisible();
  await captureScreenshot(page, testInfo, "feedback-receipt");
});
