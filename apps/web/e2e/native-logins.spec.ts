import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

for (const viewport of [
  { name: "desktop", width: 1100, height: 1000 },
  { name: "narrow-web", width: 390, height: 844 },
]) {
  test(`native sign-in is scoped and remains revocable (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    let enabled = true;
    const account = {
      credentialId: "personal-codex",
      label: "Personal review",
      harness: "codex",
      computerId: "computer-fixture",
      endpoint: "https://chatgpt.com/backend-api/codex",
      state: {
        state: "pending",
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: "TEST-1234",
        expiresAt: null,
      },
    };
    await page.route("**/rpc/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (value: unknown) => route.fulfill({ json: { json: value } });
      if (path.endsWith("/me"))
        return json({
          userId: "fixture",
          name: "Fixture",
          spaceId: "fixture",
          defaultProvider: "deepseek",
          defaultModel: "deepseek-chat",
        });
      if (path.endsWith("models/list"))
        return json([
          {
            provider: "deepseek",
            providerName: "DeepSeek",
            id: "deepseek-chat",
            label: "DeepSeek Chat",
            auth: "api-key",
            authHint: "API key",
          },
        ]);
      if (path.endsWith("models/credentials") || path.endsWith("models/backups")) return json([]);
      if (path.endsWith("nativeLogins/list"))
        return json({
          enabled,
          accounts: enabled
            ? []
            : [
                {
                  ...account,
                  state: { state: "ready", accountLabel: "Personal account", plan: null },
                },
              ],
          computers: [{ id: "computer-fixture", scope: "team", botName: null }],
        });
      if (path.endsWith("nativeLogins/begin")) {
        expect(route.request().postDataJSON().json).toMatchObject({
          selfHostedPersonalUse: true,
          computerId: "computer-fixture",
          harness: "codex",
          label: "Personal review",
        });
        return json(account);
      }
      if (path.endsWith("nativeLogins/status")) return json(account);
      if (path.endsWith("nativeLogins/cancel"))
        return json({ ...account, state: { state: "failed", code: "cancelled" } });
      if (path.endsWith("nativeLogins/logout"))
        return json({ ...account, state: { state: "signed_out" } });
      throw new Error(`Unexpected fixture RPC ${path}`);
    });
    await page.goto("/e2e/fixtures/model-accounts.html");
    const section = page.getByTestId("native-login-settings");
    await section.getByText("Native sign-in", { exact: true }).click();
    await section.getByRole("button", { name: "Add signed-in account", exact: true }).click();
    await section.getByLabel("Account name", { exact: true }).fill("Personal review");
    await expect(section.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
    await section
      .getByRole("switch", { name: "This is my personal, self-hosted deployment.", exact: true })
      .check();
    await captureScreenshot(page, testInfo, `native-login-scope-${viewport.name}`);
    await section.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(section.getByRole("link")).toHaveAttribute(
      "href",
      "https://auth.openai.com/codex/device",
    );
    await expect(section.getByLabel("Verification code")).toHaveText("TEST-1234");
    await captureScreenshot(page, testInfo, `native-login-pending-${viewport.name}`);
    await section.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
    enabled = false;
    await page.reload();
    await section.getByText("Native sign-in", { exact: true }).click();
    await expect(
      section.getByRole("button", { name: "Add signed-in account", exact: true }),
    ).toHaveCount(0);
    await section.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toContainText(
      "Provider sessions may remain active.",
    );
    await captureScreenshot(page, testInfo, `native-login-revoke-${viewport.name}`);
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await expect(section.getByRole("button", { name: "Reconnect", exact: true })).toBeDisabled();
  });
}
