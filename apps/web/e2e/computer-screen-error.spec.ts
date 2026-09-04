import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("screen connection failures stay visible and can be retried", async ({ page }, testInfo) => {
  await signup(page, `screen-error-${Date.now()}@rakazo.test`, "password12", "Screen Error");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });

  let failScreen = true;
  const screenUrl = "https://screen.example/vnc.html";
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test desktop</title><p>Desktop connected</p>",
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      status: failScreen ? 409 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        failScreen
          ? {
              json: {
                defined: false,
                code: "CONFLICT",
                status: 409,
                message:
                  "The computer screen is temporarily busy. Retry in a moment. File and shell tools still work.",
              },
            }
          : { json: { url: screenUrl } },
      ),
    }),
  );

  await page.getByTitle("Agent computer").click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview.getByRole("alert")).toContainText("temporarily busy");
  await expect(preview.getByTestId("computer-preview-open")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-screen-connection-error");

  failScreen = false;
  await preview.getByRole("button", { name: "Retry screen" }).click();
  await expect(preview.locator("iframe")).toHaveAttribute("src", screenUrl);
  await expect(preview.getByRole("alert")).toHaveCount(0);

  failScreen = true;
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("temporarily busy");
  await captureScreenshot(page, testInfo, "computer-full-screen-connection-error");

  failScreen = false;
  await page.getByRole("button", { name: "Retry screen" }).click();
  await expect(page.locator('iframe[title="Bot screen"]')).toHaveAttribute("src", screenUrl);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
