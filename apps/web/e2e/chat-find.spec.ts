import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("the desktop app finds text in the open chat", async ({ page }, testInfo) => {
  // Browsers keep Cmd/Ctrl+F for their own find, so the bar belongs to the desktop app.
  await page.addInitScript(() => {
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "linux",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
      },
    });
  });
  await signup(page, `find-${Date.now()}@rakazo.test`, "password12345678", "Find Chat");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const composer = page.getByRole("combobox", { name: /^Message / });
  await composer.fill("Remember the zephyrine launch window");
  await page.keyboard.press("Enter");
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText(/zephyrine launch window/).first()).toBeVisible();

  await page.keyboard.press("ControlOrMeta+F");
  const find = page.getByRole("searchbox", { name: "Find in chat" });
  await expect(find).toBeFocused();
  await find.fill("ZEPHYRINE");
  const bar = page.getByTestId("chat-find");
  await expect(bar.getByText(/^1\/\d+$/)).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get("rk-find-current")?.size ?? 0))
    .toBe(1);
  await captureScreenshot(page, testInfo, "chat-find");

  await find.fill("no such words anywhere");
  await expect(bar.getByText("0/0")).toBeVisible();
  await expect(bar.getByRole("button", { name: "Next match" })).toBeDisabled();

  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await expect.poll(() => page.evaluate(() => CSS.highlights.get("rk-find")?.size ?? 0)).toBe(0);
  await expect(composer).toBeFocused();
});
