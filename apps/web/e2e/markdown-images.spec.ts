import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const imageHost = "https://images.example.test/";
const remoteImage = `${imageHost}chart.png?d=conversation-data`;
// 1×1 transparent PNG served for the fake image host.
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function serveFakeImages(page: Page) {
  const requests: Array<{ url: string; referer?: string }> = [];
  await page.route(`${imageHost}**`, async (route) => {
    requests.push({ url: route.request().url(), referer: route.request().headers().referer });
    await route.fulfill({ status: 200, contentType: "image/png", body: pixel });
  });
  return requests;
}

async function sendImageReply(page: Page, name: string) {
  await signup(page, `${name}-${Date.now()}@rakazo.test`, "password12", "Markdown Image");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill(`Here is the chart: ![Quarterly chart](${remoteImage})`);
  await composer.press("Enter");
  // The scripted runtime echoes the prompt back, so the markdown image lands in a bot bubble.
  return page.getByTestId("message-bot-bubble").last();
}

test("remote markdown images in bot replies load only after the reader asks", async ({
  page,
}, testInfo) => {
  const requests = await serveFakeImages(page);
  const bubble = await sendImageReply(page, "markdown-image");

  const placeholder = bubble.getByRole("button", { name: /Quarterly chart/ });
  await expect(placeholder).toBeVisible({ timeout: 20_000 });
  await expect(placeholder).toContainText("images.example.test");
  await expect(bubble.locator("img")).toHaveCount(0);
  expect(requests).toEqual([]);
  await captureScreenshot(page, testInfo, "markdown-remote-image-placeholder");

  await placeholder.focus();
  await page.keyboard.press("Enter");
  const image = bubble.getByRole("img", { name: "Quarterly chart" });
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("src", remoteImage);
  expect(requests.map((request) => request.url)).toEqual([remoteImage]);
  expect(requests[0]?.referer).toBeUndefined();
});

test("remote markdown images load at once when the reader turned that on", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.loadRemoteImages", "on"));
  const requests = await serveFakeImages(page);
  const bubble = await sendImageReply(page, "markdown-image-auto");

  await expect(bubble.getByRole("img", { name: "Quarterly chart" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(bubble.getByRole("button", { name: /Quarterly chart/ })).toHaveCount(0);
  expect(requests.map((request) => request.url)).toContain(remoteImage);
});
