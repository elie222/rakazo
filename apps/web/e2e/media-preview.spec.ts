import { expect, test } from "@playwright/test";
import { FAKE_VIDEO_BASE64 } from "../../../packages/adapters/src/fake-media-assets";
import { captureScreenshot } from "./helpers";

test("generated MP4 opens a playable preview with download", async ({ page }, testInfo) => {
  await page.route("**/rpc/artifacts/get", (route) =>
    route.fulfill({ json: { json: { contentBase64: FAKE_VIDEO_BASE64, mimeType: "video/mp4" } } }),
  );
  await page.goto("/e2e/fixtures/media-preview.html");
  await page.getByRole("button", { name: "Preview generated-video.mp4" }).click();
  const dialog = page.getByRole("dialog", { name: "generated-video.mp4" });
  const video = dialog.locator("video");
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(1);
  await expect(video).toHaveAttribute("controls", "");
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 1280);
  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0.1);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await captureScreenshot(page, testInfo, "generated-video-preview");
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download generated-video.mp4" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("generated-video.mp4");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
