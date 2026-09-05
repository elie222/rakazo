import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

for (const theme of ["light", "dark"] as const) {
  for (const width of [375, 1440]) {
    test(`Convex login and signup ${theme} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript(
        (value) => localStorage.setItem("rakazo.uiAppearance", value),
        theme,
      );
      await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
      await page.route("**/api/auth/capabilities", (route) =>
        route.fulfill({
          json: {
            provider: "convex-company-os",
            companyOsOrigin: "https://company.example",
            passwordReset: false,
            resetUrl: null,
          },
        }),
      );
      await page.goto("/");
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole("heading", { name: "Sign in to Cadre" })).toBeVisible();
      await expect(page.getByRole("img", { name: "Cadre", exact: true })).toBeVisible();
      const signIn = page.getByRole("button", {
        name: "Continue with Company OS",
      });
      await expect(signIn).toBeVisible();
      expect(
        await signIn.evaluate(
          (node) =>
            parseFloat(getComputedStyle(node).borderTopLeftRadius) >=
            node.getBoundingClientRect().height / 2,
        ),
      ).toBe(true);
      await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await captureScreenshot(page, testInfo, `cadre-login-${theme}-${width}`);
      await page.goto("/signup");
      await expect(page.getByRole("heading", { name: "Create your Cadre" })).toBeVisible();
      await expect(page.getByRole("img", { name: "Cadre", exact: true })).toBeVisible();
      await captureScreenshot(page, testInfo, `cadre-signup-${theme}-${width}`);
      await page.goto("/app/test-bot");
      await expect(page).toHaveURL(/\/login\?next=/);
      await page.route("**/api/auth/sign-in/oauth2", async (route) => {
        expect(route.request().postDataJSON()).toMatchObject({
          providerId: "company-os",
          callbackURL: new URL("/app/test-bot", page.url()).href,
        });
        await route.fulfill({
          json: {
            url: "https://company.example/oauth/authorize",
            redirect: true,
          },
        });
      });
      await page.route("https://company.example/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "Company OS consent" }),
      );
      await page.getByRole("button", { name: "Continue with Company OS" }).click();
      await expect(page).toHaveURL("https://company.example/oauth/authorize");
    });
  }
}
