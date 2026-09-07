import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("desktop update can be checked, deferred, and installed from settings", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    let installAttempts = 0;
    let state = {
      phase: "idle",
      currentVersion: "0.1.2",
      availableVersion: null as string | null,
      percent: null as number | null,
      message: null as string | null,
      checkedAt: null as string | null,
    };
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "darwin",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
        update: {
          state: async () => state,
          check: async () => {
            state = { ...state, phase: "downloading", availableVersion: "0.1.3", percent: 50 };
            setTimeout(() => {
              state = { ...state, phase: "ready", percent: 100 };
            }, 3_000);
            return state;
          },
          install: async () => {
            if (++installAttempts === 1) {
              state = { ...state, message: "The update could not be completed. Try again later." };
              return state;
            }
            document.documentElement.dataset.updateInstalled = "true";
            return state;
          },
        },
      },
    });
  });
  const stamp = Date.now();
  await signup(page, `desktop-update-${stamp}@rakazo.test`, "password12", "Update Tester");
  await completeOnboarding(page);
  await expect(page.getByRole("complementary", { name: "Desktop update" })).toHaveCount(0);
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("desktop-update-settings");
  await expect(settings.getByText("v0.1.2")).toBeVisible();
  await settings.getByRole("button", { name: "Check for updates" }).click();
  await expect(settings.getByRole("button", { name: "Downloading…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  const prompt = page.getByRole("complementary", { name: "Desktop update" });
  await expect(prompt).toBeVisible({ timeout: 10_000 });
  await captureScreenshot(page, testInfo, "desktop-update-ready");
  await prompt.getByRole("button", { name: "Later" }).click();
  await expect(prompt).toHaveCount(0);
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Restart to update" })).toBeVisible();
  await captureScreenshot(page, testInfo, "desktop-update-settings");
  await settings.getByRole("button", { name: "Restart to update" }).click();
  await expect(settings.getByRole("status")).toHaveText(
    "The update could not be completed. Try again later.",
  );
  await settings.getByRole("button", { name: "Restart to update" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-update-installed", "true");
});

test("ordinary web sessions do not show desktop update controls", async ({ page }) => {
  await signup(page, `web-update-${Date.now()}@rakazo.test`, "password12", "Web Tester");
  await completeOnboarding(page);
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("desktop-update-settings")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Desktop update" })).toHaveCount(0);
});
