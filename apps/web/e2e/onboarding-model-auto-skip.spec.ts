import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("onboarding skips model connect when a default model is already available", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: false } },
    });
  });

  const stamp = Date.now();
  await signup(
    page,
    `model-auto-skip-${stamp}@rakazo.test`,
    "password12",
    `Model auto skip ${stamp}`,
  );

  await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Skip for now" })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "onboarding-model-auto-skip");

  const createRequest = page.waitForRequest("**/rpc/bots/create");
  await page.getByRole("button", { name: "Continue" }).click();
  expect((await createRequest).postDataJSON()).toMatchObject({
    json: { name: "Chief", title: "", description: "", instructions: "" },
  });
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible();
});
