import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

for (const viewport of [
  { name: "desktop", width: 1100, height: 1000 },
  { name: "narrow-web", width: 390, height: 844 },
]) {
  test(`same-provider accounts stay independent (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    let credentials = [
      {
        id: "team",
        provider: "openai-compatible",
        label: "Team",
        hasKey: true,
        isDefault: true,
        authKind: "openai_compatible",
        baseUrl: "https://team.example.test/v1",
        modelId: "team-model",
      },
      {
        id: "project",
        provider: "openai-compatible",
        label: "Project",
        hasKey: true,
        isDefault: false,
        authKind: "openai_compatible",
        baseUrl: "https://project.example.test/v1",
        modelId: "project-model",
      },
    ];
    await page.route("**/rpc/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("nativeLogins/list"))
        return route.fulfill({ json: { json: { enabled: false, accounts: [], computers: [] } } });
      const json = (value: unknown) => route.fulfill({ json: { json: value } });
      if (path.endsWith("/me"))
        return json({
          userId: "fixture",
          name: "Fixture",
          spaceId: "fixture",
          defaultProvider: "openai-compatible",
          defaultModel: "team-model",
        });
      if (path.endsWith("models/list"))
        return json([
          {
            provider: "openai-compatible",
            providerName: "OpenAI-compatible",
            id: "custom",
            label: "Custom model",
            auth: "api-key",
            authHint: "Custom server",
            placeholder: true,
          },
        ]);
      if (path.endsWith("models/credentials")) return json(credentials);
      if (path.endsWith("models/backups")) return json([]);
      if (path.endsWith("models/connect")) {
        const input = route.request().postDataJSON().json;
        if (input.createNew) {
          expect(input.makeDefault).toBe(false);
          expect(input.credentialId).toBeUndefined();
          const created = {
            ...credentials[1]!,
            ...input,
            id: "additional",
            hasKey: true,
            isDefault: false,
          };
          credentials = [...credentials, created];
          return json(created);
        }
        expect(input.credentialId).toBe("project");
        const renamed = { ...credentials[1]!, label: input.label };
        credentials = [credentials[0]!, renamed];
        return json(renamed);
      }
      throw new Error(`Unexpected fixture RPC ${path}`);
    });
    await page.goto("/e2e/fixtures/model-accounts.html");
    await page.getByLabel("Account", { exact: true }).selectOption("project");
    await expect(page.getByLabel("OpenAI-compatible server URL")).toHaveValue(
      "https://project.example.test/v1",
    );
    await page.getByLabel("Account name", { exact: true }).fill("Project review");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByLabel("Account", { exact: true }).locator("option:checked")).toHaveText(
      "Project review",
    );
    await captureScreenshot(page, testInfo, `model-account-selected-${viewport.name}`);
    await page.getByLabel("Account", { exact: true }).selectOption("new");
    await expect(page.getByLabel("OpenAI-compatible server URL")).toHaveValue("");
    await page.getByLabel("Account name", { exact: true }).fill("Additional account");
    await page
      .getByLabel("OpenAI-compatible server URL")
      .fill("https://additional.example.test/v1");
    await page.getByLabel("Model id", { exact: true }).fill("additional-model");
    await captureScreenshot(page, testInfo, `model-account-new-${viewport.name}`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByLabel("Account", { exact: true })).toHaveValue("additional");
    expect(credentials[0]!.isDefault).toBe(true);
    expect(credentials).toHaveLength(3);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
  });
}
