import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

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
  await composer.fill(`Read the [guide](${destination})`);
  await composer.press("Enter");

  const link = page.getByTestId("message-bot-bubble").last().getByRole("link", { name: "guide" });
  await expect(link).toBeVisible({ timeout: 20_000 });
  await link.click();

  const dialog = page.getByRole("alertdialog", { name: "Open external link?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(destination);
  await expect(dialog.locator("strong")).toHaveText("docs.example.test");
  await expect(dialog.getByRole("button", { name: "Always open example.test" })).toBeVisible();
  await captureScreenshot(page, testInfo, "external-link-confirm");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\//);

  const popupPromise = page.waitForEvent("popup");
  await link.click();
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(destination);
});

test("always opening a site skips the prompt until it is removed in Settings", async ({
  page,
}, testInfo) => {
  await page
    .context()
    .route("https://docs.example.test/**", (route) =>
      route.fulfill({ body: "Docs", contentType: "text/plain" }),
    );
  const stamp = Date.now();
  await signup(page, `trusted-link-${stamp}@rakazo.test`, "password12", "Trusted Link");
  await completeOnboarding(page);

  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill(`Read the [guide](${destination})`);
  await composer.press("Enter");

  const link = page.getByTestId("message-bot-bubble").last().getByRole("link", { name: "guide" });
  await expect(link).toBeVisible({ timeout: 20_000 });
  const dialog = page.getByRole("alertdialog", { name: "Open external link?" });

  // "Always open" opens this link and saves its site, so the next link opens with no prompt.
  await link.click();
  const trusted = page.waitForResponse(
    (response) => response.url().includes("/rpc/trustedLinkSites/trust") && response.ok(),
  );
  const firstPopup = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "Always open example.test" }).click();
  await expect(await firstPopup).toHaveURL(destination);
  await trusted;
  await expect(dialog).toHaveCount(0);
  expect(await rpc<string[]>(page, "trustedLinkSites/list", {})).toEqual(["example.test"]);

  await page.bringToFront();
  const secondPopup = page.waitForEvent("popup");
  await link.click();
  await expect(await secondPopup).toHaveURL(destination);
  await expect(dialog).toHaveCount(0);

  // Settings list the site; removing it brings the prompt back.
  await page.bringToFront();
  const settings = await openUserSettings(page);
  const group = settings.getByTestId("trusted-link-sites");
  await expect(group).toContainText("Trusted sites");
  await expect(group).toContainText("example.test");
  await group.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "external-link-trusted-sites");

  const removed = page.waitForResponse(
    (response) => response.url().includes("/rpc/trustedLinkSites/remove") && response.ok(),
  );
  await group.getByRole("button", { name: "Remove example.test", exact: true }).click();
  await removed;
  await expect(group).toHaveCount(0);
  expect(await rpc<string[]>(page, "trustedLinkSites/list", {})).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await link.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
});
