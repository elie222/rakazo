import { expect, test } from "@playwright/test";
import type { AccountSessions } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("saved accounts switch, receive hidden-account notifications, and sign out independently", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const familyEmail = `family+${stamp}@example.test`;
  const workEmail = `work+${stamp}@example.test`;
  const password = "password12";
  await page.addInitScript(() => {
    const notifications: Array<{ title: string; body?: string; onclick?: () => void }> = [];
    Object.assign(window, { accountNotifications: notifications });
    class NotificationFixture {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick?: () => void;
      onclose?: () => void;
      body?: string;
      constructor(
        public title: string,
        options?: { body?: string },
      ) {
        this.body = options?.body;
        notifications.push(this);
      }
      close() {
        this.onclose?.();
      }
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: NotificationFixture,
    });
  });
  await signup(page, familyEmail, password, "Family");
  await completeOnboarding(page);
  const familyBot = activeBotId(page);
  const familySession = await (await page.request.get("/api/auth/get-session")).json();
  const familyId = familySession.user.id as string;

  const workContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const workPage = await workContext.newPage();
  try {
    await signup(workPage, workEmail, password, "Work");
    await completeOnboarding(workPage);
    const workBot = activeBotId(workPage);
    await workPage.goto("about:blank");

    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Add account", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in\?add=1$/);
    await page.getByLabel("Email", { exact: true }).fill(workEmail);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/${workBot}$`));
    await page.getByTestId("user-menu-trigger").click();
    const escaped = (email: string) => new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const familyRow = page.getByRole("button", { name: escaped(familyEmail) });
    const workRow = page.getByRole("button", { name: escaped(workEmail) });
    const header = page.getByTestId("account-menu-header");
    await expect(header).toContainText(workEmail);
    await expect(familyRow).toBeVisible();
    await expect(workRow).toHaveCount(0);
    await captureScreenshot(page, testInfo, "multi-account-switcher");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Escape");
    const sidebar = page.getByTestId("user-menu-trigger");
    const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
    if (await navigation.isVisible()) await navigation.click();
    await expect(sidebar).toBeInViewport();
    await sidebar.click();
    await expect(header).toContainText(workEmail);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await captureScreenshot(page, testInfo, "multi-account-switcher-phone");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.keyboard.press("Escape");
    await page.getByTestId("user-menu-trigger").click();
    await familyRow.click();
    await expect(page).toHaveURL(new RegExp(`/app/${familyBot}$`));
    const otherTab = await page.context().newPage();
    await otherTab.goto(`/app/${familyBot}`);
    await expect(otherTab.getByTestId("user-menu-trigger")).toHaveAttribute(
      "aria-label",
      "Account menu for Family",
    );
    await page.bringToFront();
    // A reply is produced by the real emulated API while its account is not displayed.
    await page.waitForResponse(
      (response) => response.url().endsWith("/api/accounts") && response.ok(),
    );
    await rpc(workPage, "threads/send", { botId: workBot, text: "Reply with a short greeting." });
    await expect
      .poll(async () => {
        const feed = (await (await page.request.get("/api/accounts")).json()) as AccountSessions;
        return feed.accounts.find((account) => account.email === workEmail)?.unread ?? 0;
      })
      .toBeGreaterThan(0);
    await page.getByTestId("user-menu-trigger").click();
    await expect(workRow).toContainText(/1$/);
    await captureScreenshot(page, testInfo, "multi-account-unread");
    await expect
      .poll(() =>
        page.evaluate((email) => {
          const state = window as unknown as { accountNotifications: Array<{ body?: string }> };
          return state.accountNotifications.some((item) => item.body?.includes(email));
        }, workEmail),
      )
      .toBe(true);
    await expect(page.getByTestId("user-menu-trigger")).toHaveAttribute(
      "aria-label",
      "Account menu for Family",
    );
    await page.evaluate((email) => {
      const state = window as unknown as {
        accountNotifications: Array<{ body?: string; onclick?: () => void }>;
      };
      state.accountNotifications.findLast((item) => item.body?.includes(email))?.onclick?.();
    }, workEmail);
    await expect(page).toHaveURL(new RegExp(`/app/${workBot}$`));
    await expect(otherTab.getByTestId("user-menu-trigger")).toHaveAttribute(
      "aria-label",
      "Account menu for Work",
    );
    const stale = await page.request.post("/rpc/me", {
      data: { json: null },
      headers: { "x-rakazo-user-id": familyId },
    });
    expect(stale.status()).toBe(401);
    await otherTab.close();
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await expect(page.getByTestId("user-menu-trigger")).toHaveAttribute(
      "aria-label",
      "Account menu for Family",
    );
    const remaining = (await (await page.request.get("/api/accounts")).json()) as AccountSessions;
    expect(remaining.accounts.map((account) => account.email)).toEqual([familyEmail]);
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Add account", exact: true }).click();
    await page.getByLabel("Email", { exact: true }).fill(workEmail);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/${workBot}$`));
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Log out all accounts", exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "Log out all accounts?" });
    await expect(confirmation).toBeVisible();
    await captureScreenshot(page, testInfo, "multi-account-sign-out-all");
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirmation).toBeHidden();
    const cancelled = (await (await page.request.get("/api/accounts")).json()) as AccountSessions;
    expect(cancelled.accounts.map((account) => account.email).sort()).toEqual(
      [familyEmail, workEmail].sort(),
    );
    await expect(page).toHaveURL(new RegExp(`/app/${workBot}$`));
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Log out all accounts", exact: true }).click();
    await confirmation.getByRole("button", { name: "Log out all accounts", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
    const signedOut = (await (await page.request.get("/api/accounts")).json()) as AccountSessions;
    expect(signedOut.accounts).toEqual([]);
  } finally {
    await workContext.close();
  }
});
