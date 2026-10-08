import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const destination = "https://docs.example.test/guide?from=chat";

test("opening a bot reply link asks before leaving the app", async ({ page }, testInfo) => {
  await page
    .context()
    .route("https://docs.example.test/**", (route) =>
      route.fulfill({ body: "Docs", contentType: "text/plain" }),
    );
  const stamp = Date.now();
  await signup(page, `external-link-${stamp}@rakazo.test`, "password12", "External Link");
  await completeOnboarding(page);

  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill(`Read the [guide](${destination})`);
  await composer.press("Enter");

  const link = page.getByTestId("message-bot-bubble").last().getByRole("link", { name: "guide" });
  await expect(link).toBeVisible({ timeout: 20_000 });
  await link.click();

  const dialog = page.getByRole("alertdialog", { name: "Open external link?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(destination);
  await expect(dialog.locator("strong")).toHaveText("docs.example.test");
  await captureScreenshot(page, testInfo, "external-link-confirm");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\//);

  const popupPromise = page.waitForEvent("popup");
  await link.click();
  await dialog.getByRole("button", { name: "Open" }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(destination);
});
