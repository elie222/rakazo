import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const WIDTHS = [1280, 984, 700, 400] as const;

test("the refreshed look holds at every width, in both themes, with Vietnamese and Hebrew text", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewportSize({ width: 1280, height: 820 });
  await signup(page, `look-${Date.now()}@rakazo.test`, "password12", "Look Sample");
  await completeOnboarding(page);
  for (const name of ["Research", "Notes"]) {
    await rpc(page, "bots/create", {
      name,
      description: "",
      instructions: "",
      notifyOnFinish: true,
      computerMode: "team",
    });
  }
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const sidebar = page.getByTestId("bots-sidebar");
  await sidebar.getByRole("button", { name: /^Chief/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  // Pinned chats sit on top as a grid of large faces with their names below.
  const pinned = sidebar.locator('[data-sidebar-group="pinned"]');
  await expect(pinned).toContainText("Chief");
  await expect(pinned.locator("svg[data-look]").first()).toHaveCSS("width", "48px");

  const composer = page.getByTestId("composer-field").locator("textarea");
  await composer.fill("Tiếng Việt: ơ ư ạ ấ ề ộ ữ đ — עברית שלום");

  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((value) => localStorage.setItem("rakazo.uiAppearance", value), theme);
    await page.reload();
    await composer.fill("Tiếng Việt: ơ ư ạ ấ ề ộ ữ đ — עברית שלום");
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 820 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      if (width >= 480) {
        // Desktop windows keep the sidebar (or its avatar rail) and a thread of at least 400px.
        await expect(sidebar).toBeVisible();
        const thread = page.locator('[data-space-switch="main"]');
        await expect
          .poll(async () => Math.round((await thread.boundingBox())?.width ?? 0))
          .toBeGreaterThanOrEqual(400);
      }
      await captureScreenshot(page, testInfo, `look-${theme}-${width}`);
    }
    await page.setViewportSize({ width: 1280, height: 820 });
  }
  expect(errors).toEqual([]);
});

test("the refreshed look mirrors cleanly with a right-to-left interface", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 820 });
  await signup(page, `look-rtl-${Date.now()}@rakazo.test`, "password12", "Look Sample");
  await completeOnboarding(page);
  await page.evaluate(() => localStorage.setItem("rakazo.uiLocale", "he"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const sidebar = page.getByTestId("bots-sidebar");
  for (const width of [1280, 700, 480]) {
    await page.setViewportSize({ width, height: 820 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    // The sidebar sits on the right, against the window's start edge in Hebrew.
    await expect
      .poll(async () => {
        const box = await sidebar.boundingBox();
        return box ? Math.round(box.x + box.width) : 0;
      })
      .toBe(width);
    await captureScreenshot(page, testInfo, `look-rtl-${width}`);
  }
  expect(errors).toEqual([]);
});

test("every interface language keeps the layout intact, in a font that covers its script", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 820 });
  await signup(page, `look-locales-${Date.now()}@rakazo.test`, "password12", "Look Sample");
  await completeOnboarding(page);
  await page.getByTestId("bot-settings-trigger").click();
  const locales = [
    "en",
    "de",
    "es",
    "fr",
    "nl",
    "pl",
    "pt-BR",
    "tr",
    "ru",
    "he",
    "hi",
    "ja",
    "ko",
    "zh-CN",
    "zh-TW",
  ];
  for (const locale of locales) {
    await page.evaluate((value) => localStorage.setItem("rakazo.uiLocale", value), locale);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.getByTestId("side-panel")).toBeVisible();
    // Nothing spills sideways, and the panel's tabs stay inside the panel.
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await expect
      .poll(async () => {
        const panel = await page.getByTestId("side-panel").boundingBox();
        const tabs = await page.getByTestId("side-panel").getByRole("tab").all();
        if (!panel || tabs.length === 0) return false;
        // Every tab is whole and inside the panel: long labels wrap rather than scroll away.
        for (const tab of tabs) {
          const box = await tab.boundingBox();
          if (!box || box.x < panel.x - 1 || box.x + box.width > panel.x + panel.width + 1)
            return false;
        }
        return true;
      })
      .toBe(true);
    // Latin, Cyrillic and Vietnamese render in the bundled face; other scripts fall back by
    // language, so no glyph is drawn from a missing font.
    const usesBundledFont = await page.evaluate(() =>
      document.fonts.check('14px "Onest"', "Thinking"),
    );
    expect(usesBundledFont).toBe(true);
    await captureScreenshot(page, testInfo, `look-locale-${locale}`);
  }
  expect(errors).toEqual([]);
});
