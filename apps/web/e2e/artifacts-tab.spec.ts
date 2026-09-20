import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("opens Artifacts from the app rail and lists created files", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `artifacts-tab-${stamp}@rakazo.test`, "password12", "Artifacts Tab");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = activeBotId(page);

  const rail = page.getByTestId("app-rail");
  await expect(rail).toBeVisible();
  await rail.getByRole("link", { name: "Artifacts" }).click();
  await expect(page).toHaveURL(/\/app\/artifacts$/);
  await expect(page.getByRole("heading", { name: "Artifacts", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Filters" })).toBeVisible();
  await expect(page.getByText("No artifacts found.")).toBeVisible();
  await captureScreenshot(page, testInfo, "artifacts-empty");

  await rpc(page, "artifacts/create", {
    botId: chiefId,
    name: "notes/artifacts-tab.md",
    mimeType: "text/markdown",
    contentBase64: Buffer.from("# Artifacts tab").toString("base64"),
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Artifacts", exact: true })).toBeVisible();
  await expect(page.getByText("notes/artifacts-tab.md")).toBeVisible();
  await captureScreenshot(page, testInfo, "artifacts-list");

  await page.getByRole("link", { name: /notes\/artifacts-tab\.md/ }).click();
  await expect(page).toHaveURL(/\/app\/artifacts\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "notes/artifacts-tab.md" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Artifacts tab" })).toBeVisible();
  await captureScreenshot(page, testInfo, "artifacts-preview");
});
