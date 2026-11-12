import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  makeAdmin,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("an admin sets the voice for everyone without their own", async ({ page }, testInfo) => {
  await signup(page, `deployment-voice-${randomUUID()}@rakazo.test`, "password12", "Voice admin");
  await completeOnboarding(page);
  // Providers come from the server's catalog; the deployment shares only those with a key.
  const catalog = await rpc<{ id: string; name: string; keyless?: boolean }[]>(
    page,
    "voice/catalog",
    null,
  );
  const providers = catalog.filter(
    (entry) => !entry.keyless && !["openai-compatible", "scripted"].includes(entry.id),
  );
  const provider = providers[0];
  if (!provider) throw new Error("The voice catalog lists no hosted provider");
  let settings = {
    provider: null as string | null,
    voiceId: "",
    keySaved: false,
    environmentProvider: null,
    providers,
  };
  const updates: unknown[] = [];
  await page.route("**/rpc/me", (route) => makeAdmin(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => makeAdmin(route, "bootstrap"));
  await page.route(/\/rpc\/voice\/deployment\/get(\?|$)/, (route) =>
    route.fulfill({ json: { json: settings } }),
  );
  await page.route(/\/rpc\/voice\/deployment\/voices(\?|$)/, (route) =>
    route.fulfill({
      json: {
        json: [
          { id: "voice-a", label: "Aria" },
          { id: "voice-b", label: "Bo" },
        ],
      },
    }),
  );
  await page.route(/\/rpc\/voice\/deployment\/update(\?|$)/, (route) => {
    updates.push((route.request().postDataJSON() as { json?: unknown }).json);
    settings = { ...settings, provider: provider.id, voiceId: "voice-a", keySaved: true };
    return route.fulfill({ json: { json: settings } });
  });
  await page.reload();

  const voiceSettings = await openUserSettings(page, "voice");
  const block = voiceSettings.getByTestId("deployment-voice-settings");
  await expect(block.getByRole("heading", { name: "Default for everyone" })).toBeVisible();
  await block.getByLabel("Provider").selectOption(provider.id);
  await block.getByLabel("API key").fill("test-deployment-voice-key");
  await block.getByRole("button", { name: "Save", exact: true }).click();

  await expect(block.getByLabel("API key")).toHaveAttribute("placeholder", "Saved");
  await expect(block.getByLabel("API key")).toHaveValue("");
  await expect(block.getByLabel("Voice")).toHaveValue("voice-a");
  expect(updates).toEqual([{ provider: provider.id, apiKey: "test-deployment-voice-key" }]);
  await captureScreenshot(page, testInfo, "deployment-voice-settings");
});
