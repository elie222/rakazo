import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  chooseOption,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "../helpers/helpers";

test("choose and clear an organization model in settings", async ({ page }, testInfo) => {
  await signup(page, `organization-model-${Date.now()}@rakazo.test`, "password12", "Model Preview");
  await completeOnboarding(page);
  await rpc(page, "models/organizationConnections/create", {
    provider: "openrouter",
    modelId: "anthropic/claude-haiku-5.5",
    label: "Team model",
    apiKey: "fake-organization-api-key",
  });
  await openUserSettings(page, "models");
  const picker = page.getByRole("combobox", { name: "Organization override for this Space" });
  await chooseOption(picker, "Team model");
  await expect(picker).toContainText("Team model");
  await captureScreenshot(page, testInfo, "organization-model-selection");
  const [bot] = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  const { runId } = await rpc<{ runId: string }>(page, "threads/send", {
    botId: bot!.id,
    text: "Check the organization model",
  });
  await expect
    .poll(async () => {
      const { runs } = await rpc<{ runs: Array<{ runId: string; status: string }> }>(
        page,
        "runs/list",
        { filter: "recent" },
      );
      return runs.find((run) => run.runId === runId)?.status;
    })
    .toBe("completed");
  await chooseOption(picker, "Use saved main model");
  await expect(picker).toContainText("Use saved main model");
});
