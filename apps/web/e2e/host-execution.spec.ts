import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let selection: {
      profileId: string;
      target: "workspace" | "computer";
      workspace: string;
    } | null = null;
    const harness = {
      profiles: async () => [{ id: "device-account", label: "Device account", status: "ready" }],
      selection: async () => selection,
      configure: async (input: { profileId: string | null; target?: "workspace" | "computer" }) => {
        selection = input.profileId
          ? {
              profileId: input.profileId,
              target: input.target ?? "workspace",
              workspace: "/workspace/sample-project",
            }
          : null;
        return selection;
      },
      stop: async () => {},
      disconnect: async () => {},
    };
    Object.assign(window, { rakazoDesktop: { platform: "win32", harness } });
  });
});

test("device agents disclose a workspace or remote computer only after selection", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/native-execution.html?screen=settings");
  const agent = page.getByRole("combobox", { name: "Agent", exact: true });
  const target = page.getByRole("combobox", { name: "Work on", exact: true });
  await expect(target).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Personal account", exact: true })).toHaveCount(1);
  await agent.selectOption("device:device-account");
  await expect(target).toHaveValue("workspace");
  await expect(page.getByRole("button", { name: "Change workspace", exact: true })).toHaveText(
    "sample-project",
  );
  await expect(page.getByRole("button", { name: /^Model/ })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "host-local-workspace");
  await target.selectOption("computer");
  await expect(target).toHaveValue("computer");
  await expect(page.getByRole("button", { name: "Change workspace", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "host-remote-computer");
  await agent.selectOption(JSON.stringify(["connection", "account", 1]));
  await expect(target).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Model/ })).toBeVisible();
  await expect(agent).toHaveValue(JSON.stringify(["connection", "account", 1]));
});

test("a failed server switch preserves the device choice", async ({ page }) => {
  await page.goto("/e2e/fixtures/native-execution.html?screen=settings&state=stop-failed");
  const agent = page.getByRole("combobox", { name: "Agent", exact: true, includeHidden: true });
  await agent.selectOption("device:device-account");
  await expect(agent).toHaveValue("device:device-account");
  await agent.selectOption(JSON.stringify(["connection", "account", 1]));
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Stop and switch", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(agent).toHaveValue("device:device-account");
});

test("a declined native directory dialog preserves the server choice", async ({ page }) => {
  await page.addInitScript(() => {
    window.rakazoDesktop!.harness!.configure = async () => null;
  });
  await page.goto("/e2e/fixtures/native-execution.html?screen=settings");
  const agent = page.getByRole("combobox", { name: "Agent", exact: true });
  await agent.selectOption("device:device-account");
  await expect(agent).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Work on", exact: true })).toHaveCount(0);
});
