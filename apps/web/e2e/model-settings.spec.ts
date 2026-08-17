import { expect, test } from "@playwright/test";
import { completeOnboarding, signup } from "./helpers";

test("model settings connect, replace, and cancel provider authentication", async ({ page }) => {
  const stamp = Date.now();
  const userName = `Models ${stamp}`;
  await signup(page, `models-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page, ["A bit of everything", "Clear and tight"]);

  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "⌁ Models" }).click();
  await expect(page.getByRole("button", { name: "Close model settings" })).toBeVisible();

  const providerSearch = page.getByPlaceholder("Search providers");
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await page.getByLabel("API key").fill("fake-scripted-key-one");
  await page.getByRole("button", { name: "Connect API key" }).click();
  await expect(page.getByText(/Connected and using Scripted runtime/)).toBeVisible();

  await page.getByLabel("Replace API key").fill("fake-scripted-key-two");
  await page.getByRole("button", { name: "Replace API key" }).click();
  await expect(page.getByText(/Connected and using Scripted runtime/)).toBeVisible();

  await page.route("**/rpc/models/beginOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          loginId: "fake-login",
          verificationUri: "https://example.com/device",
          userCode: "TEST-CODE",
          expiresInSeconds: 900,
        },
      }),
    });
  });
  await page.route("**/rpc/models/completeOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { status: "pending" } }),
    });
  });
  await page.evaluate(() => {
    window.open = () => null;
  });
  let finishRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/models/finishOAuth")) finishRequests += 1;
  });

  await providerSearch.fill("openai-codex");
  await page
    .getByRole("button", { name: /ChatGPT Plus\/Pro/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();
  await expect(page.getByText("Waiting for sign-in…")).toBeVisible();

  const cancelled = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await cancelled;
  expect(finishRequests).toBe(0);
  await page.getByLabel("Replace API key").fill("fake-scripted-key-three");
  await expect(page.getByRole("button", { name: "Replace API key" })).toBeEnabled();
  await expect(page.getByText("Waiting for sign-in…")).toBeHidden();
});
