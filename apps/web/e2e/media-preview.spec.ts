import { expect, test } from "@playwright/test";
import { FAKE_VIDEO_BASE64 } from "../../../packages/adapters/src/fake-media-assets";
import { captureScreenshot } from "./helpers";

test("audio plays inline and retains its download control", async ({ page }, testInfo) => {
  const wav = Buffer.alloc(16044, 128);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(16000, 40);
  let artifactFetches = 0;
  await page.route("**/rpc/artifacts/get", (route) => {
    artifactFetches += 1;
    return route.fulfill({
      json: { json: { contentBase64: wav.toString("base64"), mimeType: "audio/wav" } },
    });
  });
  await page.goto("/e2e/fixtures/media-preview.html?audio=1");
  await expect(page.getByRole("button", { name: "Play audio.wav" })).toBeVisible();
  await captureScreenshot(page, testInfo, "audio-attachment-idle");
  expect(artifactFetches).toBe(0);
  await expect(page.locator("audio")).toHaveCount(0);
  await page.getByRole("button", { name: "Play audio.wav" }).click();
  const audio = page.locator('audio[aria-label="audio.wav"]');
  await expect(audio).toBeVisible();
  await expect(audio).toHaveAttribute("controls", "");
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState))
    .toBeGreaterThanOrEqual(1);
  expect(artifactFetches).toBe(1);
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(0.1);
  await audio.evaluate((element: HTMLAudioElement) => element.pause());
  await captureScreenshot(page, testInfo, "audio-attachment");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download audio.wav" }).click();
  expect((await download).suggestedFilename()).toBe("audio.wav");
});

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
