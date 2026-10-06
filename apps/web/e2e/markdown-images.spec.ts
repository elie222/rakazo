import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const remoteImage = "https://images.example.test/chart.png?d=conversation-data";

test("bot replies show remote markdown images as links without loading them", async ({
  page,
}, testInfo) => {
  const imageRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://images.example.test/")) imageRequests.push(request.url());
  });
  const stamp = Date.now();
  await signup(page, `markdown-image-${stamp}@rakazo.test`, "password12", "Markdown Image");
  await completeOnboarding(page);

  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill(`Here is the chart: ![Quarterly chart](${remoteImage})`);
  await composer.press("Enter");

  // The scripted runtime echoes the prompt back, so the markdown image lands in a bot bubble.
  const bubble = page.getByTestId("message-bot-bubble").last();
  const link = bubble.getByRole("link", { name: "Quarterly chart" });
  await expect(link).toBeVisible({ timeout: 20_000 });
  await expect(link).toHaveAttribute("href", remoteImage);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(bubble.locator("img")).toHaveCount(0);
  expect(imageRequests).toEqual([]);
  await captureScreenshot(page, testInfo, "markdown-remote-image-link");
});
