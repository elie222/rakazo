import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

test("keyboard shortcuts list and focus the composer", async ({ page }, testInfo) => {
  await signup(page, `shortcuts-${Date.now()}@rakazo.test`, "password12", "Shortcut Keys");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const composer = page.getByRole("combobox", { name: /^Message / });
  await expect(composer).toBeVisible();

  await page.keyboard.press("ControlOrMeta+/");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Command menu")).toBeVisible();
  // The browser keeps these chords, so only the desktop app lists them.
  await expect(dialog.getByText("New group chat")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "keyboard-shortcuts");

  const html = page.locator("html");
  const originalDirection = await html.getAttribute("dir");
  await html.evaluate((element) => element.setAttribute("dir", "rtl"));
  const shortcut = dialog.locator("dl > div").filter({ hasText: "Chat details" });
  const layout = await shortcut.evaluate((row) => {
    const label = row.querySelector("dt")!;
    const chord = row.querySelector('[data-slot="kbd-group"]')!;
    const keys = [...chord.querySelectorAll("kbd")];
    const left = (element: Element) => element.getBoundingClientRect().left;
    return {
      labelDirection: getComputedStyle(label).direction,
      labelRightOfChord: left(label) > left(chord),
      domOrder: keys.map((key) => key.textContent),
      visualOrder: keys.sort((a, b) => left(a) - left(b)).map((key) => key.textContent),
    };
  });
  expect(layout.labelDirection).toBe("rtl");
  expect(layout.labelRightOfChord).toBe(true);
  expect(layout.domOrder).toHaveLength(3);
  expect(layout.visualOrder).toEqual(layout.domOrder);
  await captureScreenshot(page, testInfo, "keyboard-shortcuts-rtl");
  await html.evaluate((element, direction) => {
    if (direction === null) element.removeAttribute("dir");
    else element.setAttribute("dir", direction);
  }, originalDirection);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await composer.blur();
  await page.keyboard.press("ControlOrMeta+I");
  await expect(composer).toBeFocused();

  await page.keyboard.press("ControlOrMeta+K");
  await page.getByTestId("command-palette-action-keyboard-shortcuts").click();
  await expect(dialog).toBeVisible();
});
