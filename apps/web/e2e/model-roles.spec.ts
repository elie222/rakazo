import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ModelCatalogEntry, ModelRoleSettings } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

async function pickModel(page: Page, search: string, label: string) {
  await page.getByRole("combobox", { name: "Search models" }).fill(search);
  await page
    .getByRole("listbox", { name: "Model options" })
    .getByRole("option", { name: label, exact: true })
    .first()
    .click();
}

test("approval models reuse connections and persist independent fallbacks", async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signup(page, `model-roles-${Date.now()}@rakazo.test`, "password12", "Model roles");
  await completeOnboarding(page);
  const catalog = await rpc<ModelCatalogEntry[]>(page, "models/list", {});
  const openRouter = catalog.filter(
    (entry) => entry.provider === "openrouter" && !entry.placeholder,
  );
  const main = openRouter[0]!;
  const fallback = openRouter.find((entry) => entry.label !== main.label)!;
  await rpc(page, "models/connect", {
    provider: "openrouter",
    apiKey: "fake-role-api-key",
    modelId: main.id,
  });
  const original = await rpc<ModelRoleSettings>(page, "models/role", { role: "main" });
  await page.reload();
  await openUserSettings(page, "models");

  const approval = page.getByTestId("model-role-approval");
  await expect(approval.getByTestId("model-role-default")).toContainText("Deployment default");
  await approval.getByRole("button", { name: "Change Approval model", exact: true }).click();
  await pickModel(page, "Jev 1.14", "Jev 1.14");
  await expect(approval.getByTestId("model-role-row-1")).toContainText("Jev 1.14");
  await expect
    .poll(
      async () =>
        (await rpc<ModelRoleSettings>(page, "models/role", { role: "approval" })).primary?.modelId,
    )
    .toBe("typesafe/jev-1.14");
  await approval.getByRole("button", { name: "Add fallback", exact: true }).click();
  await pickModel(page, main.label, main.label);
  await expect(approval.getByTestId("model-role-row-2")).toContainText(main.label);
  expect(await rpc<ModelRoleSettings>(page, "models/role", { role: "main" })).toEqual(original);
  await approval.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "approval-model-with-backup");

  // The main list takes its own fallback without touching the approval list.
  const mainList = page.getByTestId("model-role-main");
  await expect(mainList.getByTestId("model-role-row-1")).toContainText(main.label);
  await mainList.getByRole("button", { name: "Add fallback", exact: true }).click();
  await pickModel(page, fallback.label, fallback.label);
  await expect(mainList.getByTestId("model-role-row-2")).toContainText(fallback.label);
  await expect
    .poll(async () => (await rpc<ModelRoleSettings>(page, "models/role", { role: "main" })).backups)
    .toHaveLength(1);
  await mainList.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "model-settings-roles");

  await page.reload();
  await expect(
    page.getByTestId("model-role-approval").getByTestId("model-role-row-1"),
  ).toContainText("Jev 1.14");
  await expect(
    page.getByTestId("model-role-approval").getByTestId("model-role-row-2"),
  ).toContainText(main.label);
  await expect(page.getByTestId("model-role-main").getByTestId("model-role-row-2")).toContainText(
    fallback.label,
  );
});
