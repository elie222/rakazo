import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

const LOCAL_MODEL_ID = "rakazo-e2e-local";
const LOCAL_MODEL_REPLY = "OpenAI-compatible endpoint verified end to end.";

test("custom connections persist reasoning support and bot thinking", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Reasoning ${stamp}`;
  await signup(page, `reasoning-model-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("openai-compatible");
  await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
  await page.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8090/v1");
  await page.getByLabel("Model id").fill("arbitrary-model");
  await expect(page.getByRole("checkbox", { name: "Supports thinking" })).toBeHidden();
  await expect(page.getByRole("checkbox", { name: "Supports images" })).toBeHidden();
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Supports thinking" }).check();
  await page.getByRole("combobox", { name: "Reasoning effort", exact: true }).selectOption("low");
  await page.getByLabel("Maximum output tokens").fill("8192");
  await page.getByLabel("Context limit").fill("65536");
  await page.getByRole("checkbox", { name: "Supports images" }).check();
  await page.getByLabel("Maximum images per request").fill("1");
  await captureScreenshot(page, testInfo, "openai-compatible-thinking-connection");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const credentials = await rpc<
    Array<{
      modelId?: string;
      reasoning?: boolean;
      thinkingLevel?: string | null;
      maxTokens?: number;
      contextWindow?: number;
      supportsImages?: boolean;
      maxImagesPerPrompt?: number;
    }>
  >(page, "models/credentials", {});
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.reasoning).toBe(true);
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.thinkingLevel).toBe(
    "low",
  );
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.maxTokens).toBe(8192);
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.contextWindow).toBe(
    65536,
  );
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.supportsImages).toBe(
    true,
  );
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.maxImagesPerPrompt).toBe(
    1,
  );
  await page.reload();
  await openUserSettings(page, "models");
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Supports thinking" })).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Reasoning effort", exact: true })).toHaveValue(
    "low",
  );
  await expect(page.getByLabel("Maximum output tokens")).toHaveValue("8192");
  await expect(page.getByLabel("Context limit")).toHaveValue("65536");
  await expect(page.getByRole("checkbox", { name: "Supports images" })).toBeChecked();
  await expect(page.getByLabel("Maximum images per request")).toHaveValue("1");
  await page.getByLabel("Maximum images per request").fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const clearedCredentials = await rpc<Array<{ modelId?: string; maxImagesPerPrompt?: number }>>(
    page,
    "models/credentials",
    {},
  );
  expect(
    clearedCredentials.find((entry) => entry.modelId === "arbitrary-model")?.maxImagesPerPrompt,
  ).toBeUndefined();
  await page.getByRole("button", { name: "Close model settings" }).click();
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  const advanced = settings.getByTestId("bot-settings-advanced");
  await advanced.evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  // NativeSelect sits inside a wrapping <label>, so label text includes option
  // copy and getByLabel(..., { exact: true }) misses the control. Use the
  // combobox accessible name, matching other model E2E tests.
  const model = settings.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toBeVisible();
  await expect(model).toContainText("arbitrary-model");
  // Value key — not a /arbitrary-model/ label match, which also hits "Space default (arbitrary-model)".
  await model.selectOption("openai-compatible::arbitrary-model");
  const thinking = settings.getByRole("combobox", { name: "Thinking", exact: true });
  await expect(thinking).toBeVisible();
  await thinking.selectOption("low");
  await thinking.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "openai-compatible-thinking");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await saved;
  await page.reload();
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  await expect(settings).toBeVisible();
  await advanced.evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await expect(thinking).toHaveValue("low");
});

test("connects, lists, and uses an OpenAI-compatible endpoint", async ({ page }, testInfo) => {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: LOCAL_MODEL_ID }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      const created = Math.floor(Date.now() / 1_000);
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-rakazo-e2e",
          object: "chat.completion.chunk",
          created,
          model: LOCAL_MODEL_ID,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: LOCAL_MODEL_REPLY },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-rakazo-e2e",
          object: "chat.completion.chunk",
          created,
          model: LOCAL_MODEL_ID,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const stamp = Date.now();
    const userName = `Local model ${stamp}`;
    await signup(page, `local-model-${stamp}@rakazo.test`, "password12", userName);
    await completeOnboarding(page);

    await openUserSettings(page, "models");
    const providerSearch = page.getByPlaceholder("Search providers");
    await providerSearch.fill("openai-compatible");
    await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
    await expect(
      page.getByText("Paste the OpenAI-compatible address", { exact: false }),
    ).toBeHidden();
    await page.getByText("Setup help", { exact: true }).click();
    await expect(
      page.getByText("Paste the OpenAI-compatible address", { exact: false }),
    ).toBeVisible();
    await page.getByText("Setup help", { exact: true }).click();
    await expect(
      page.getByText("Paste the OpenAI-compatible address", { exact: false }),
    ).toBeHidden();
    await page.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await page.getByLabel("Model id").fill("manual-model-not-listed");
    await page.getByRole("button", { name: "Find models" }).click();

    await expect(page.getByLabel("Model id")).toHaveValue("manual-model-not-listed");
    await page.getByRole("button", { name: "Use a found model" }).click();
    const discoveredModels = page.getByRole("combobox", { name: "Models from server" });
    await expect(discoveredModels).toHaveValue(LOCAL_MODEL_ID);
    await discoveredModels.selectOption("");
    await expect(page.getByLabel("Model id")).toBeVisible();
    await page.getByRole("button", { name: "Find models" }).click();
    await expect(discoveredModels).toHaveValue(LOCAL_MODEL_ID);
    await expect(page.getByText("Found 1 model.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await captureScreenshot(page, testInfo, "openai-compatible-model-discovery");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /OpenAI-compatible/ })).toContainText(
      "Connected",
    );
    await captureScreenshot(page, testInfo, "openai-compatible-connected");

    await page.getByLabel("OpenAI-compatible server URL").fill("");
    await expect(page.getByRole("button", { name: "Find models" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

    if (process.env.AGENT_RUNTIME === "pi") {
      await page.getByRole("button", { name: "Close model settings" }).click();
      const composer = page.getByPlaceholder(/Message/);
      await composer.fill("Reply with the endpoint verification message.");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("transcript").getByText(LOCAL_MODEL_REPLY)).toBeVisible({
        timeout: 30_000,
      });
      await captureScreenshot(page, testInfo, "openai-compatible-response");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("model settings connect, replace, and cancel provider authentication", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Models ${stamp}`;
  await signup(page, `models-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await openUserSettings(page, "models");
  await expect(page.getByRole("button", { name: "Close model settings" })).toBeVisible();

  const providerSearch = page.getByPlaceholder("Search providers");
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText(
    /Scripted runtime/,
  );
  const apiKeyInput = page.getByLabel("API key");
  await expect(apiKeyInput).toHaveAttribute("autocomplete", "new-password");
  await apiKeyInput.fill("fake-scripted-key-one");
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByLabel("Maximum output tokens").fill("8192");
  await captureScreenshot(page, testInfo, "builtin-provider-max-tokens");
  await page.getByRole("button", { name: "Connect API key" }).click();
  await expect(page.getByText(/Connected and using Scripted runtime/)).toBeVisible();
  const connected = await rpc<Array<{ provider: string; maxTokens?: number }>>(
    page,
    "models/credentials",
    {},
  );
  expect(connected.find((entry) => entry.provider === "scripted")?.maxTokens).toBe(8192);
  // Connecting preserves the open disclosure; only open it if the form remounted.
  const outputLimit = page.getByLabel("Maximum output tokens");
  if (!(await outputLimit.isVisible())) {
    await page.getByText("Advanced", { exact: true }).click();
  }
  await outputLimit.fill("16384");
  await page.getByRole("button", { name: "Save limits", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const updated = await rpc<Array<{ provider: string; maxTokens?: number }>>(
    page,
    "models/credentials",
    {},
  );
  expect(updated.find((entry) => entry.provider === "scripted")?.maxTokens).toBe(16384);
  await page.reload();
  await openUserSettings(page, "models");
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText(
    /Scripted runtime/,
  );
  const storedKey = page.getByLabel("Replace API key");
  await expect(storedKey).toHaveValue("");
  await expect(storedKey).toHaveAttribute("placeholder", "Paste a replacement key");
  await captureScreenshot(page, testInfo, "stored-provider-api-key");
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByLabel("Maximum output tokens")).toHaveValue("16384");

  // Connected providers get their own section with the saved model inline;
  // searching flattens back to one ranked list.
  await providerSearch.fill("");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByText("All providers", { exact: true })).toBeVisible();
  const scriptedRow = page.getByRole("button", { name: /^Scripted/ });
  await expect(scriptedRow).toContainText("Scripted runtime");
  await providerSearch.fill("scripted");
  await expect(page.getByText("All providers", { exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: /Scripted/ })).toContainText("Connected");
  await page.getByRole("button", { name: /Scripted/ }).click();

  await page.getByLabel("Replace API key").fill("fake-scripted-key-two");
  await page.getByRole("button", { name: "Replace API key" }).click();
  await expect(page.getByText(/Connected and using Scripted runtime/)).toBeVisible();

  const codexCredential = {
    id: "cred-codex",
    provider: "openai-codex",
    label: "ChatGPT Plus/Pro",
    hasKey: false,
    isDefault: false,
    modelId: "gpt-6-luna",
    authKind: "oauth",
  };
  let oauthReady = false;
  let oauthFinished = false;
  await page.route("**/rpc/models/credentials", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: unknown[] };
    if (oauthFinished) body.json.push(codexCredential);
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.route("**/rpc/models/beginOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          loginId: "fake-login",
          provider: "openai-codex",
          mode: "device-code",
          verificationUri: "https://example.com/device",
          userCode: "TEST-CODE",
          expiresInSeconds: 900,
        },
      }),
    });
  });
  await page.route("**/rpc/models/completeOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { status: oauthReady ? "ready" : "pending" } }),
    });
  });
  await page.route("**/rpc/models/finishOAuth", async (route) => {
    oauthFinished = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: codexCredential }),
    });
  });
  await page.evaluate(() => {
    window.open = () => null;
  });
  let finishRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/models/finishOAuth")) finishRequests += 1;
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  await providerSearch.fill("openai-codex");
  await page
    .getByRole("button", { name: /ChatGPT Plus\/Pro/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();

  // The popup is blocked (window.open returned null): the card still carries the
  // code, a copy button, the expiry, and a way to abandon the attempt.
  await expect(page.getByText("TEST-CODE")).toBeVisible();
  await expect(page.getByRole("link", { name: "example.com/device" })).toBeVisible();
  await expect(page.getByText(/code expires in about 15 minutes/)).toBeVisible();
  await captureScreenshot(page, testInfo, "oauth-device-code-card");
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("TEST-CODE");

  const cancelledByButton = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await cancelledByButton;
  await expect(page.getByText("TEST-CODE")).toBeHidden();

  // A canceled attempt leaves sign-in reusable.
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();
  await expect(page.getByText("TEST-CODE")).toBeVisible();

  const cancelled = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await cancelled;
  expect(finishRequests).toBe(0);
  await page.getByLabel("Replace API key").fill("fake-scripted-key-three");
  await expect(page.getByRole("button", { name: "Replace API key" })).toBeEnabled();
  await expect(page.getByText("TEST-CODE")).toBeHidden();

  // A finished sign-in relabels the action so re-clicking reads as a reconnect.
  oauthReady = true;
  await providerSearch.fill("openai-codex");
  await page
    .getByRole("button", { name: /ChatGPT Plus\/Pro/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();
  await expect(page.getByText(/Connected and using/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in again", exact: true })).toBeVisible();

  // Disconnect removes the credential and its Connected marker.
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  const confirmDisconnect = page.getByRole("alertdialog");
  await expect(
    confirmDisconnect.getByRole("heading", { name: "Disconnect Scripted?" }),
  ).toBeVisible();
  await confirmDisconnect.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText(/Disconnected Scripted/)).toBeVisible();
  const afterDisconnect = await rpc<Array<{ provider: string }>>(page, "models/credentials", {});
  expect(afterDisconnect.some((entry) => entry.provider === "scripted")).toBe(false);
  await expect(page.getByRole("button", { name: /Scripted/ })).not.toContainText("Connected");
});

test("a deployment default on server credentials says so and keeps an own key optional", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `server-credentials-${stamp}@rakazo.test`, "password12", `Server ${stamp}`);
  await completeOnboarding(page);
  // The E2E deployment runs on a scripted model, so present the active default as one that
  // authenticates from the host, the way an Amazon Bedrock deployment on an AWS role does.
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: {
        ...body,
        json: {
          ...body.json,
          defaultProvider: "amazon-bedrock",
          defaultModel: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
          hostCredentialProvider: "amazon-bedrock",
          hostCredentialSource: "AWS IAM",
        },
      },
    });
  });
  await openUserSettings(page, "models");

  const serverNote = page.getByText(
    "Uses this server's own AWS IAM credentials to access Amazon Bedrock.",
  );
  const ownKeyDisclosure = page.getByText("Use your own key", { exact: true });
  await expect(serverNote).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect API key" })).toBeHidden();
  await captureScreenshot(page, testInfo, "model-settings-server-credentials");

  await ownKeyDisclosure.click();
  await expect(page.getByRole("button", { name: "Connect API key" })).toBeVisible();
  await expect(serverNote).toBeVisible();
  await ownKeyDisclosure.click();
  await expect(page.getByRole("button", { name: "Connect API key" })).toBeHidden();
  await expect(serverNote).toBeVisible();
});

test("a key connected in another space can replace server credentials for the same model", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `shared-model-${stamp}@rakazo.test`, "password12", "Model Owner");
  await completeOnboarding(page);
  const otherSpace = await rpc<{ id: string }>(page, "spaces/create", { name: "Other space" });
  const provider = "amazon-bedrock";
  const modelId = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
  const connected = await page.request.post("/rpc/models/connect", {
    headers: { "x-rakazo-space-id": otherSpace.id },
    data: { json: { provider, modelId, apiKey: "fake-bedrock-key" } },
  });
  expect(connected.ok()).toBe(true);
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    // The offline deployment uses Scripted; expose its untouched default as host Bedrock.
    if (body.json.defaultProvider !== provider) {
      Object.assign(body.json, {
        defaultProvider: provider,
        defaultModel: modelId,
        hostCredentialProvider: provider,
        hostCredentialSource: "AWS IAM",
      });
    }
    await route.fulfill({ response, json: body });
  });
  await openUserSettings(page, "models");
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText(
    /Claude Haiku/,
  );
  await expect(
    page.getByText("Uses this server's own AWS IAM credentials to access Amazon Bedrock."),
  ).toBeVisible();
  const useModel = page.getByRole("button", { name: "Use this model", exact: true });
  await expect(useModel).toBeVisible();
  const personalBillingNote = page.getByText(
    "Uses your Amazon Bedrock API key. Rakazo does not pay for model usage.",
  );
  await expect(personalBillingNote).toBeHidden();
  await captureScreenshot(page, testInfo, "model-settings-server-credentials-connected-key");
  const saved = page.waitForRequest("**/rpc/models/setDefault");
  await useModel.click();
  const request = await saved;
  expect(request.postDataJSON().json).toMatchObject({ provider, modelId });
  expect(request.headers()["x-rakazo-space-id"]).not.toBe(otherSpace.id);
  await expect(page.getByText(/Now using/)).toBeVisible();
  await expect(useModel).toBeHidden();
  await expect(personalBillingNote).toBeVisible();
  await expect(
    page.getByText("Uses this server's own AWS IAM credentials to access Amazon Bedrock."),
  ).toBeHidden();
  expect(await rpc(page, "me", {})).toMatchObject({
    defaultProvider: provider,
    defaultModel: modelId,
    hostCredentialProvider: null,
  });
});

test("catalog models keep a space default thinking level per saved model", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `catalog-thinking-${stamp}@rakazo.test`, "password12", `Thinking ${stamp}`);
  await completeOnboarding(page);

  await openUserSettings(page, "models");
  const providerSearch = page.getByPlaceholder("Search providers");

  // A non-reasoning provider never shows the control.
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await expect(page.getByRole("combobox", { name: "Thinking", exact: true })).toBeHidden();

  await providerSearch.fill("anthropic");
  await page.getByRole("button", { name: /^Anthropic / }).click();
  await page.getByLabel("API key").fill("fake-anthropic-key");
  await page.getByRole("button", { name: "Connect API key" }).click();
  await expect(page.getByText(/Connected and using/)).toBeVisible();

  const thinking = page.getByRole("combobox", { name: "Thinking", exact: true });
  await expect(thinking).toBeVisible();
  await expect(thinking).toHaveValue("");
  await thinking.selectOption("high");
  await captureScreenshot(page, testInfo, "catalog-model-thinking");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Now using/)).toBeVisible();
  // The Active model banner surfaces the effective effort while the model can think.
  await expect(page.getByText("Thinking: High", { exact: true })).toBeVisible();

  const credentials = await rpc<Array<{ provider: string; thinkingLevel?: string | null }>>(
    page,
    "models/credentials",
    {},
  );
  expect(credentials.find((entry) => entry.provider === "anthropic")?.thinkingLevel).toBe("high");

  // The level persists across reloads while the same model stays selected.
  await page.reload();
  await openUserSettings(page, "models");
  await providerSearch.fill("anthropic");
  await page.getByRole("button", { name: /^Anthropic / }).click();
  await expect(page.getByRole("combobox", { name: "Thinking", exact: true })).toHaveValue("high");

  // The stored level is bound to the saved model: staging another model resets the
  // staged level, and saving the new model clears the old level instead of leaking it.
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "Claude Opus 4.8", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Thinking", exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Use this model", exact: true }).click();
  await expect(page.getByText(/Now using/)).toBeVisible();
  const updated = await rpc<Array<{ provider: string; thinkingLevel?: string | null }>>(
    page,
    "models/credentials",
    {},
  );
  expect(updated.find((entry) => entry.provider === "anthropic")?.thinkingLevel).toBeUndefined();
});

test("saves and reloads an ordered backup model list for connected models", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `backup-models-${stamp}@rakazo.test`, "password12", `Backups ${stamp}`);
  await completeOnboarding(page);

  const catalog = await rpc<
    Array<{
      provider: string;
      id: string;
      label: string;
      providerName?: string;
      placeholder?: boolean;
    }>
  >(page, "models/list", {});
  const targets = ["anthropic", "openai"].map((provider) => {
    const model = catalog.find((entry) => entry.provider === provider && !entry.placeholder);
    expect(model, `expected a ${provider} catalog entry`).toBeDefined();
    return model!;
  });
  // Fake credentials exercise the connected-model picker without calling a provider.
  for (const model of targets) {
    await rpc(page, "models/connect", {
      provider: model.provider,
      apiKey: `fake-backup-${model.provider}-key`,
      modelId: model.id,
    });
  }

  const settings = await openUserSettings(page, "models");
  const panel = settings.getByTestId("model-backups");
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Add connected models to use them as backups.")).toBeVisible();
  const picker = panel.getByRole("combobox", { name: "Add connected model" });
  const firstValue = JSON.stringify([targets[0]!.provider, targets[0]!.id]);
  const secondValue = JSON.stringify([targets[1]!.provider, targets[1]!.id]);
  await picker.selectOption(firstValue);
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await picker.selectOption(secondValue);
  await panel.getByRole("button", { name: "Add", exact: true }).click();

  const firstLabel = `${targets[0]!.providerName ?? targets[0]!.provider} · ${targets[0]!.label}`;
  const secondLabel = `${targets[1]!.providerName ?? targets[1]!.provider} · ${targets[1]!.label}`;
  await panel.getByRole("button", { name: `Move ${secondLabel} up` }).click();
  const rows = panel.locator('[data-testid^="model-backup-"]');
  await expect(rows.nth(0)).toContainText(secondLabel);
  await expect(rows.nth(1)).toContainText(firstLabel);
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeInViewport();

  const savedResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/models/setBackups") && response.ok(),
  );
  await panel.getByRole("button", { name: "Save backups", exact: true }).click();
  await savedResponse;
  await expect(panel.getByText("Backup models saved.")).toBeVisible();
  expect(await rpc(page, "models/backups", {})).toEqual([
    { provider: targets[1]!.provider, modelId: targets[1]!.id },
    { provider: targets[0]!.provider, modelId: targets[0]!.id },
  ]);

  await page.reload();
  const reloadedSettings = await openUserSettings(page, "models");
  const reloadedPanel = reloadedSettings.getByTestId("model-backups");
  await reloadedPanel.scrollIntoViewIfNeeded();
  const reloadedRows = reloadedPanel.locator('[data-testid^="model-backup-"]');
  await expect(reloadedRows.nth(0)).toContainText(secondLabel);
  await expect(reloadedRows.nth(1)).toContainText(firstLabel);
  await reloadedPanel.scrollIntoViewIfNeeded();
  await expect(reloadedPanel).toBeInViewport();
  await testInfo.attach("settings-backup-models-control", {
    body: await reloadedPanel.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
  await captureScreenshot(page, testInfo, "settings-backup-models-order");
  await reloadedPanel.getByRole("button", { name: `Remove ${firstLabel}` }).click();
  const removalResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/models/setBackups") && response.ok(),
  );
  await reloadedPanel.getByRole("button", { name: "Save backups", exact: true }).click();
  await removalResponse;
  expect(await rpc(page, "models/backups", {})).toEqual([
    { provider: targets[1]!.provider, modelId: targets[1]!.id },
  ]);
});
