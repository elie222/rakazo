import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openBotPanelTab,
  signup,
} from "./helpers";

test("a bot's Logs tab lists the tools it called and what they did on its computer", async ({
  page,
}, testInfo) => {
  await signup(page, `work-log-${Date.now()}@rakazo.test`, "password12", "Log Reader");
  await completeOnboarding(page);
  const at = new Date().toISOString();
  const action = { executionId: "e", cwd: "/work", status: "done", exitCode: 0, output: "" };
  const entries = [
    {
      id: "1",
      createdAt: at,
      runId: "run-1",
      tool: "shell",
      action: { ...action, kind: "shell", command: "pnpm test", exitCode: 1, output: "1 failed" },
    },
    {
      id: "2",
      createdAt: at,
      runId: "run-1",
      tool: "write_file",
      action: { ...action, kind: "write_file", command: "notes/plan.md", bytes: 2048 },
    },
    { id: "3", createdAt: at, runId: "run-1", tool: "web_search" },
  ];
  await page.route("**/rpc/bots/workLog", (route) => route.fulfill({ json: { json: entries } }));
  await createNamedBot(page, "Logger");
  await openBotPanelTab(page, "Logs");
  const panel = page.getByTestId("bot-settings");
  await expect(panel.getByText("pnpm test")).toBeVisible();
  await expect(panel.getByText("notes/plan.md")).toBeVisible();
  await expect(panel.getByText("web_search")).toBeVisible();
  await panel.getByText("pnpm test").click();
  await expect(panel.getByText("1 failed")).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-work-log");
});
