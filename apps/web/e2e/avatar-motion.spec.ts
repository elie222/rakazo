import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const playStates = (svg: SVGSVGElement) => [
  ...new Set(
    [svg, ...svg.querySelectorAll(".avatar-eye, .avatar-gaze, .avatar-cheer")].flatMap((element) =>
      element
        .getAnimations()
        .filter((track) => track instanceof CSSAnimation)
        .map((track) => track.playState),
    ),
  ),
];

test("working photos bounce as plain circles while idle photos stay still", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/avatar-motion.html");

  const working = page.locator(".avatar-working");
  await expect(working).toHaveAttribute("data-working", "true");
  const picture = working.locator(".rakazo-bot-avatar-picture");
  await expect(picture).toBeVisible();
  await expect(working.locator("svg")).toHaveCount(0);
  await expect(picture).toHaveCSS("overflow-x", "hidden");
  await expect(working).toHaveCSS("animation-name", "avatar-bounce");
  const first = await working.evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(300);
  expect(await working.evaluate((el) => getComputedStyle(el).transform)).not.toBe(first);

  const idle = page.locator(".avatar-idle");
  await expect(idle).toHaveAttribute("data-working", "false");
  await expect(idle).toHaveCSS("animation-name", "none");
  await captureScreenshot(page, testInfo, "avatar-photo-working-and-idle");
});

test("avatars stay still when reduced motion is enabled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/e2e/fixtures/avatar-motion.html");

  const photo = page.locator(".avatar-working");
  await expect(photo).toHaveAttribute("data-working", "true");
  await expect(photo).toHaveCSS("animation-name", "none");
  const organic = page.locator(".avatar-organic");
  await page.getByRole("button", { name: "Idle" }).click();
  await expect(organic).toHaveAttribute("data-working", "true");
  await expect(organic).toHaveCSS("animation-name", "none");
  expect(await organic.evaluate(playStates)).toEqual([]);
});

test("a working face loops only while visible, and a hovered face looks at the pointer", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/avatar-motion.html");
  const avatar = page.locator(".avatar-organic");
  await expect(avatar).toHaveAttribute("data-working", "false");
  // Idle faces draw no frames.
  expect(await avatar.evaluate(playStates)).toEqual([]);

  const look = avatar.locator(".avatar-look");
  const box = (await avatar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width - 4, box.y + 6, { steps: 4 });
  await expect
    .poll(() => look.evaluate((el: SVGGElement) => el.style.transform))
    .toMatch(/^translate\(\d/);
  await captureScreenshot(page, testInfo, "avatar-face-looks-at-pointer");
  await page.mouse.move(box.x + box.width + 300, box.y + box.height + 300);
  await expect.poll(() => look.evaluate((el: SVGGElement) => el.style.transform)).toBe("");

  await page.getByRole("button", { name: "Idle" }).click();
  await expect(avatar).toHaveAttribute("data-working", "true");
  await expect(avatar).toHaveCSS("animation-name", "avatar-jolly");
  await expect(avatar.locator(".avatar-eye").first()).toHaveCSS(
    "animation-name",
    "avatar-eyes-work",
  );
  expect(await avatar.evaluate(playStates)).toEqual(["running"]);

  await avatar.evaluate((svg) => {
    svg.closest<HTMLElement>(".avatar-example")!.style.marginTop = "2200px";
  });
  await expect(avatar).toHaveAttribute("data-paused", "true");
  expect(await avatar.evaluate(playStates)).toEqual(["paused"]);
  await avatar.evaluate((svg) => {
    svg.closest<HTMLElement>(".avatar-example")!.style.marginTop = "0";
  });
  await expect(avatar).toHaveAttribute("data-paused", "false");

  const setHidden = (hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await setHidden(true);
  await expect(avatar).toHaveAttribute("data-paused", "true");
  expect(await avatar.evaluate(playStates)).toEqual(["paused"]);
  await setHidden(false);
  await expect(avatar).toHaveAttribute("data-paused", "false");
  expect(await avatar.evaluate(playStates)).toEqual(["running"]);
});
