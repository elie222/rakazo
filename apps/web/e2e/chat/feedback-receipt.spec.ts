import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

test("the chat shows a submitted feedback receipt and can copy its reference", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/e2e/fixtures/gallery.html?scenario=feedback&theme=light");

  const receipt = page.getByTestId("feedback-receipt");
  await expect(receipt.getByText("Bug report sent")).toBeVisible();
  await expect(receipt.getByText("The preview stayed blank after I opened a file.")).toBeVisible();
  await expect(receipt.getByText("Receipt example-report-1")).toBeVisible();
  await captureScreenshot(page, testInfo, "feedback-receipt");

  await receipt.hover();
  await page
    .locator("[data-message-id]")
    .filter({ has: receipt })
    .getByRole("button", { name: "More" })
    .click();
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("The preview stayed blank after I opened a file.\nReceipt example-report-1");
});
