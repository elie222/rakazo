import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

test("files dropped anywhere on the chat attach to the composer", async ({ page }, testInfo) => {
  await signup(page, `file-drop-${Date.now()}@rakazo.test`, "password12", "Drop Tester");
  await completeOnboarding(page);
  await expect(page.getByRole("combobox", { name: /Message/ })).toBeVisible();
  const transcript = page.getByTestId("transcript");
  const overlay = page.getByTestId("file-drop-overlay");
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["Meeting notes"], "notes.txt", { type: "text/plain" }));
    return transfer;
  });

  await transcript.dispatchEvent("dragenter", { dataTransfer });
  await transcript.dispatchEvent("dragover", { dataTransfer });
  await expect(overlay).toBeVisible();
  await captureScreenshot(page, testInfo, "01-file-drop-overlay");

  await transcript.dispatchEvent("drop", { dataTransfer });
  await expect(overlay).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove notes.txt", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "02-dropped-file-attached");
});
