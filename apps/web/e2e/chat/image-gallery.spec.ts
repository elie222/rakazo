import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

const images = [
  {
    name: "first.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAk1BMVEURERETExMQEBASEhIQEBAREREREREQEBBMaXEQEBAQEBARERERERERERERERH///9nZ2doaGgSEhJ4eHj39/eWlpbJycn8/PwmJibe3t7q6uojIyNFRUXb29sxMTFYWFg0NDT9/f3s7OxeXl4UFBQTExO3t7eysrIaGhoYGBjNzc3IyMhHR0dCQkL19fVycnJ5eXmjkUUsAAAADnRSTlMdJ6ocrK/u8gDxqe3s8MU5/BQAAAAJcEhZcwAACxMAAAsTAQCanBgAAADOSURBVDiNjZPnEsIgEIQvGk1RWUmzxVijxv7+T+dEJyZjgHN/AfsN3C1ALtmO0MjpWS7RQBjUJ7JNvhAd0u7/kUeC0d9AMB4H9WpjVgESiGsgBmQbQFj5IdpAfgQ2u894NQEO+98iiwsQXcvR7Q6cT+0uFktguxYimwOzqarN7O1UnCqHNAKSBIhSRQ7f6upaVUmGaHarAB4l8NQDK+aIlCkyY9pcMEEVTNQ5d1mSu27JPRj2yWnFA8zHGVHPDPhk9U3+sEsudTyd7fld9wUHZD2tj6fJ8AAAAABJRU5ErkJggg==",
      "base64",
    ),
  },
  {
    name: "second.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAq1BMVEVMaXEvbt4ubOAubt0ub90vbt0vb94AAP8vb90vbt4vbt4vbd8ubt0tcN0vb90ubt4wbd4vbt4ubt4vbt0vb90vbt0ubd8tcOAubt0vb98ubt0rbdoub94ub94ubt4vb98vb90vbt4wbN4ub94ub9wtcN0xcNwtbtwvbd4ub94ub94vcNwxcdsub90ub94ubt0ubt0ucNwvbt////8vb976/P6buu/5+/6cu++O08doAAAAM3RSTlMA+SG/7NjzAde92UHWVMfJP+nEgYD0MTLGIFMj6n5/MILyL/pSPTQzVvHaOyS+VzyDQlE1yrfgAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA60lEQVQ4ja2T5xKCMAyAGYIFUVABB+69V+N4/yfzrq2sNuedZ/4l33clbYKm/TGq64lpRREx2x0l3riQhlWvlnniQyEaRpGfm0UOULnmeW1e5gB6kHFjIHOAyiHtz1dxgO6n0xPPX3cq4v7glb44wOVpyil98grhwkqcmHFKRSlmwgUXQiaYuOAwYYcLFhNsXLCZMMWFLRNcXOD3PH5rso0LQyZ0cGHGn9rCntoTw6rz9CEN6/YZd0M97la6mD31wiTZSgW6zPVlfin38tLWimttdEvf70k/Tp9k2FuUMYs4dIhtE2c0VuJf4w0gWXeUasIjGgAAAABJRU5ErkJggg==",
      "base64",
    ),
  },
];

test("a chat's images open in one lightbox that moves between them", async ({ page }, testInfo) => {
  await signup(page, `image-gallery-${Date.now()}@rakazo.test`, "password12", "Image Viewer");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(images);
  for (const image of images) {
    await expect(
      page.getByRole("button", { name: `Remove ${image.name}`, exact: true }),
    ).toBeVisible();
  }
  await composer.fill("Two pictures");
  await composer.press("Enter");

  const transcript = page.getByTestId("transcript");
  await transcript.getByRole("img", { name: "first.png" }).click();
  const lightbox = page.getByRole("dialog", { name: "first.png" });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByText("1 / 2")).toBeVisible();
  await expect(lightbox.getByRole("button", { name: "Next image" })).toBeVisible();
  await captureScreenshot(page, testInfo, "chat-image-gallery");

  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "second.png" }).getByText("2 / 2")).toBeVisible();
  await page.getByRole("button", { name: "Previous image" }).click();
  await expect(page.getByRole("dialog", { name: "first.png" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
