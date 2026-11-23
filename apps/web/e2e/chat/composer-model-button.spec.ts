// The model button beside Send never sits over the message: at five widths, in either direction,
// with a short or long model name and an empty, short, long or multi-line draft.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

type Box = { x: number; y: number; width: number; height: number };

const widths = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "phone", width: 390, height: 844 },
  { name: "small-phone", width: 320, height: 640 },
];
const drafts = {
  empty: "",
  short: "Hello there",
  long: "Please draft a detailed onboarding plan for a new operations manager covering week one through week four, with meetings, systems access and goals",
  multiline: "First line of the draft\nSecond line\nThird line",
};
const longName = "Vendor Very Long Model Name Extended Context Preview 2026-11-01";

function intersects(a: Box, b: Box) {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5
  );
}

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}

async function expectApart(page: Page, label: string) {
  const bar = page.getByTestId("composer-bar");
  // "Model: …" in any language; the other buttons' names have no colon.
  const picker = bar.getByRole("button", { name: /:/ });
  const text = bar.locator("textarea");
  const send = bar.locator("button").last();
  const attach = bar.locator("button").first();
  const pickerBox = await box(picker);
  for (const [name, other] of [
    ["message", text],
    ["send", send],
    ["attach", attach],
  ] as const) {
    expect(intersects(pickerBox, await box(other)), `${label}: model button over ${name}`).toBe(
      false,
    );
  }
  // Nothing inside the button (icon, name, chevron) is painted past its edges.
  const spill = await picker.evaluate((button) => {
    const outer = button.getBoundingClientRect();
    const inner = button.firstElementChild!.getBoundingClientRect();
    return inner.left < outer.left - 0.5 || inner.right > outer.right + 0.5;
  });
  expect(spill, `${label}: model button content spills`).toBe(false);
  // The message keeps a usable width, and the page never scrolls sideways.
  expect((await box(text)).width, `${label}: message width`).toBeGreaterThanOrEqual(120);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
}

for (const lang of ["en", "he"] as const) {
  test(`the model button never covers the message (${lang})`, async ({ page }, testInfo) => {
    for (const viewport of widths) {
      await page.setViewportSize(viewport);
      for (const model of ["short", "long"] as const) {
        await page.goto(`/e2e/fixtures/composer-model-button.html?lang=${lang}&model=${model}`);
        await expect(page.locator("html")).toHaveAttribute("dir", lang === "he" ? "rtl" : "ltr");
        const text = page.getByTestId("composer-bar").locator("textarea");
        for (const [draft, value] of Object.entries(drafts)) {
          await text.fill(value);
          // The box picks one line or two after it measures the draft, so check the settled layout.
          await expect(async () =>
            expectApart(page, `${lang} ${viewport.name} ${model} ${draft}`),
          ).toPass({ timeout: 5_000 });
          if (model === "long" && draft === "short")
            await captureScreenshot(
              page,
              testInfo,
              `composer-model-button-${lang}-${viewport.name}`,
            );
        }
      }
    }
  });
}

test("a long model name is cut off with an ellipsis and shown in full on hover", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e/fixtures/composer-model-button.html?model=long&detail=High");
  const picker = page.getByTestId("composer-bar").getByRole("button", { name: /^Model:/ });
  const name = picker.locator("span.truncate");
  await expect(name).toHaveCSS("text-overflow", "ellipsis");
  expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(picker).toHaveAttribute("title", `Model: ${longName}, High`);
  await expect(picker).toHaveAccessibleName(`Model: ${longName}, High`);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the model button is at least 44px to tap", async ({ page }) => {
    await page.goto("/e2e/fixtures/composer-model-button.html?model=long");
    const picker = page.getByTestId("composer-bar").getByRole("button", { name: /^Model:/ });
    const button = await box(picker);
    expect(button.width).toBeGreaterThanOrEqual(44);
    // The tap area reaches 22px either side of the middle, though the button draws 32px tall.
    const hits = await picker.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const middle = rect.top + rect.height / 2;
      return [middle - 21.5, middle + 21.5].map((y) =>
        element.contains(document.elementFromPoint(x, y)),
      );
    });
    expect(hits).toEqual([true, true]);
  });
});
