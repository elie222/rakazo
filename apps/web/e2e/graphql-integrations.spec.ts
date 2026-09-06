import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("advanced GraphQL install shows Add GraphQL in MCP, OpenAPI, GraphQL, Executor, Treg order", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `graphql-source-${stamp}@rakazo.test`, "password12", `GraphQL ${stamp}`);
  await completeOnboarding(page);

  await page.getByText("Integrations").click();
  await expect(page.getByPlaceholder("Search apps")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add GraphQL", exact: true })).toBeHidden();

  const advanced = page.getByTestId("integrations-advanced");
  await advanced.evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });

  await expect(page.getByRole("button", { name: "Add MCP server", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add OpenAPI", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add GraphQL", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Executor", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Treg", exact: true })).toBeVisible();

  const advancedActions = advanced.locator("button");
  await expect(advancedActions.nth(0)).toHaveText("MCP servers");
  await expect(advancedActions.nth(1)).toHaveText("Add MCP server");
  await expect(advancedActions.nth(2)).toHaveText("Add OpenAPI");
  await expect(advancedActions.nth(3)).toHaveText("Add GraphQL");
  await expect(advancedActions.nth(4)).toHaveText("Add Executor");
  await expect(advancedActions.nth(5)).toHaveText("Add Treg");
  await captureScreenshot(page, testInfo, "01-graphql-advanced-order");

  await page.getByRole("button", { name: "Add GraphQL", exact: true }).click();
  await page.getByPlaceholder("Display name").fill("Browser GraphQL");
  await page
    .getByPlaceholder("https://example.com/graphql")
    .fill("https://graphql.example.test/graphql");
  await page.getByRole("button", { name: "Verify and add", exact: true }).click();
  await expect(
    page.getByText(/GRAPHQL · https:\/\/graphql\.example\.test\/graphql · no auth/),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "02-graphql-installed");
});
