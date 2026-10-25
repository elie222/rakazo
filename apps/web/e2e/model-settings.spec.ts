import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  chooseOption,
  completeOnboarding,
  expandAdvancedSection,
  manageModelConnection,
  modelConnectionDialog,
  modelConnectOption,
  openModelConnection,
  openUserSettings,
  pickReopenedModel,
  rpc,
  signup,
} from "./helpers";

const LOCAL_MODEL_ID = "rakazo-e2e-local";
const SECOND_MODEL_ID = "rakazo-e2e-second";
const LOCAL_MODEL_REPLY = "OpenAI-compatible endpoint verified end to end.";

test("model settings cleanup frames", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const stamp = Date.now();
  await signup(page, `model-cleanup-${stamp}@rakazo.test`, "password12", "Model Preview");
  await completeOnboarding(page);

  // Keep account persistence real; the harness supplies offline provider verification.
  // Hide the deployment default so the first frame exercises the empty-provider state.
  let providerConnected = false;
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    body.json.needsModel = !providerConnected;
    await route.fulfill({ response, json: body });
  });
  await openUserSettings(page, "models");
  const mainList = page.getByTestId("model-role-main");
  await expect(mainList.getByTestId("model-role-default")).toContainText("Choose a model");
  const dialog = await openModelConnection(page, "OpenRouter");
  await expect(dialog.getByLabel("API key")).toBeVisible();
  await captureScreenshot(page, testInfo, "model-settings-cleanup-1-not-connected");

  await dialog.getByLabel("API key").fill("rejected-fixture-key");
  await dialog.getByRole("button", { name: "Connect API key", exact: true }).click();
  await expect(
    dialog.getByText("API key was rejected by the provider.", { exact: true }),
  ).toBeVisible();
  const rejected = await rpc<Array<{ provider: string }>>(page, "models/credentials", {});
  expect(rejected.some((credential) => credential.provider === "openrouter")).toBe(false);
  await captureScreenshot(page, testInfo, "model-settings-cleanup-1a-rejected-key");

  // Connecting from the empty first slot makes the provider's model the main model.
  await dialog.getByLabel("API key").fill("fake-cleanup-api-key");
  providerConnected = true;
  await dialog.getByRole("button", { name: "Connect API key", exact: true }).click();
  await expect(dialog).toBeHidden();
  await pickReopenedModel(page);
  const primary = mainList.getByTestId("model-role-row-1");
  await expect(primary).toContainText("OpenRouter");
  const addFallback = mainList.getByRole("button", { name: "Add fallback", exact: true });
  await expect(addFallback).toBeVisible();
  await captureScreenshot(page, testInfo, "model-settings-cleanup-2-connected");

  const model = primary.getByRole("button", { name: /^Change / });
  await model.click();
  const options = page.getByRole("listbox", { name: "Model options" });
  await expect(options).toBeVisible();
  await captureScreenshot(page, testInfo, "model-settings-cleanup-3-model-dropdown-open");

  // The popup must paint above the settings scroll pane, including its lower edge.
  const popup = page.locator('[data-slot="popover-content"]');
  await expect(popup).toBeVisible();
  expect(
    await popup.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.bottom - 2);
      return hit !== null && element.contains(hit);
    }),
  ).toBe(true);
  const search = page.getByRole("combobox", { name: "Search models" });
  await expect(search).toBeFocused();
  await search.fill("gpt");
  const firstModel = await options.getByRole("option").first().locator("span").first().innerText();
  await search.press("Home");
  await search.press("Enter");
  await expect(popup).toBeHidden();
  await expect(primary).toContainText(firstModel);
  await primary.getByRole("button", { name: /^Change / }).click();
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(popup).toBeHidden();
  await primary.getByRole("button", { name: /^Change / }).click();
  await expect(search).toBeFocused();
  await mainList.getByRole("heading", { name: "Main model", exact: true }).click();
  await expect(popup).toBeHidden();

  // Choosing a fallback saves it at once; there is no separate save step.
  await addFallback.click();
  await expect(options).toBeVisible();
  await captureScreenshot(page, testInfo, "model-settings-cleanup-4-backup-menu-open");
  const backupItem = options.getByRole("option").first();
  const backupLabel = (await backupItem.innerText()).trim();
  await backupItem.click();
  await expect(options).toBeHidden();
  await expect(mainList.getByTestId("model-role-row-2")).toContainText(backupLabel);
  await expect.poll(async () => (await rpc<unknown[]>(page, "models/backups", {})).length).toBe(1);
  await mainList.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "model-settings-cleanup-5-backup-added");
});

test("custom connections persist reasoning support and bot thinking", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Reasoning ${stamp}`;
  await signup(page, `reasoning-model-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await openUserSettings(page, "models");
  const dialog = await openModelConnection(page, "OpenAI-compatible");
  await dialog.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8090/v1");
  await dialog.getByLabel("Model id").fill("arbitrary-model");
  await expect(page.getByRole("checkbox", { name: "Supports thinking" })).toBeHidden();
  await expect(page.getByRole("checkbox", { name: "Supports images" })).toBeHidden();
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Supports thinking" }).check();
  await chooseOption(page.getByRole("combobox", { name: "Reasoning effort", exact: true }), "Low");
  await page.getByLabel("Maximum output tokens").fill("8192");
  await page.getByLabel("Context limit").fill("65536");
  await page.getByRole("checkbox", { name: "Supports images" }).check();
  await page.getByLabel("Maximum images per request").fill("1");
  await captureScreenshot(page, testInfo, "openai-compatible-thinking-connection");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await pickReopenedModel(page);
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("model-role-main").getByTestId("model-role-row-1")).toContainText(
    "arbitrary-model",
  );
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
  const connection = await manageModelConnection(page, "OpenAI-compatible");
  await connection.getByText("Advanced", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Supports thinking" })).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Reasoning effort", exact: true })).toHaveText(
    "Low",
  );
  await expect(page.getByLabel("Maximum output tokens")).toHaveValue("8192");
  await expect(page.getByLabel("Context limit")).toHaveValue("65536");
  await expect(page.getByRole("checkbox", { name: "Supports images" })).toBeChecked();
  await expect(page.getByLabel("Maximum images per request")).toHaveValue("1");
  await page.getByLabel("Maximum images per request").fill("");
  // "Default" is the empty option, so choosing it clears the saved level.
  await chooseOption(
    page.getByRole("combobox", { name: "Reasoning effort", exact: true }),
    "Default",
  );
  await connection.getByRole("button", { name: "Save", exact: true }).click();
  await expect(connection).toBeHidden();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const clearedCredentials = await rpc<
    Array<{ modelId?: string; maxImagesPerPrompt?: number; thinkingLevel?: string | null }>
  >(page, "models/credentials", {});
  const cleared = clearedCredentials.find((entry) => entry.modelId === "arbitrary-model");
  expect(cleared).toBeDefined();
  expect(cleared?.maxImagesPerPrompt).toBeUndefined();
  expect(cleared?.thinkingLevel ?? null).toBeNull();
  await page.getByRole("button", { name: "Close model settings" }).click();
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  await expandAdvancedSection(settings.getByTestId("bot-settings-advanced"));
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
  await expandAdvancedSection(settings.getByTestId("bot-settings-advanced"));
  await expect(thinking).toHaveValue("low");
});

test("the bot's model picker marks models that cannot read images", async ({ page }, testInfo) => {
  await page.route("**/rpc/models/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      json: Array<{ provider: string; id: string; label: string; images?: boolean }>;
    };
    const template = body.json.find((entry) => entry.provider === "openrouter");
    if (!template) throw new Error("Missing OpenRouter catalog fixture");
    await route.fulfill({
      response,
      json: {
        ...body,
        json: [
          ...body.json.filter((entry) => entry.provider !== "openrouter"),
          { ...template, id: "fixture-text", label: "Text-only model", images: false },
          ...Array.from({ length: 10 }, (_, index) => ({
            ...template,
            id: `fixture-vision-${index + 1}`,
            label: `Vision model ${index + 1}`,
            images: true,
          })),
        ],
      },
    });
  });
  // A connected OpenRouter key offers its catalog models to the bot.
  await page.route("**/rpc/models/credentials", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Array<Record<string, unknown>> };
    await route.fulfill({
      response,
      json: {
        ...body,
        json: [
          ...body.json,
          {
            id: "fixture-openrouter",
            provider: "openrouter",
            label: "OpenRouter",
            hasKey: true,
            isDefault: false,
          },
        ],
      },
    });
  });
  await signup(page, `bot-text-only-${Date.now()}@rakazo.test`, "password12", "Bot Models");
  await completeOnboarding(page);
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  await expandAdvancedSection(settings.getByTestId("bot-settings-advanced"));

  // Past ten choices the model field becomes a searchable button.
  const picker = settings.getByRole("button", { name: "Model", exact: true });
  await expect(picker).toBeVisible();
  await picker.click();
  await page.getByRole("combobox", { name: "Search models" }).fill("model");
  const textOnly = page.getByRole("option", { name: "OpenRouter · Text-only model", exact: true });
  const vision = page.getByRole("option", { name: "OpenRouter · Vision model 1", exact: true });
  await expect(textOnly).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-model-picker-text-only-row");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await captureScreenshot(page, testInfo, "bot-model-picker-text-only-row-dark");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await expect(textOnly.getByTitle("Can't read images")).toBeVisible();
  await expect(textOnly).toHaveAccessibleDescription("Can't read images");
  await expect(vision.getByTitle("Can't read images")).toHaveCount(0);

  await textOnly.click();
  await expect(picker).toContainText("Text-only model");
  await picker.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "bot-model-picker-text-only-selected");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await captureScreenshot(page, testInfo, "bot-model-picker-text-only-selected-dark");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await expect(picker.getByTitle("Can't read images")).toBeVisible();
  await expect(picker).toHaveAccessibleDescription("Can't read images");

  await picker.click();
  await page.getByRole("combobox", { name: "Search models" }).fill("Vision model 1");
  await vision.click();
  await expect(picker.getByTitle("Can't read images")).toHaveCount(0);
});

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error(`fake /v1/chat/completions got a non-JSON body: ${String(error)}`));
      }
    });
  });
}

async function fulfillWithoutModelStep(route: Route) {
  const response = await route.fetch();
  const body = (await response.json()) as { json: Record<string, unknown> };
  await route.fulfill({ response, json: { ...body, json: { ...body.json, needsModel: false } } });
}

test("connects, lists, and uses an OpenAI-compatible endpoint", async ({ page }, testInfo) => {
  const completionBodies: Array<Record<string, unknown>> = [];
  const completionHeaders: Array<string | string[] | undefined> = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ object: "list", data: [{ id: LOCAL_MODEL_ID }, { id: SECOND_MODEL_ID }] }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      try {
        completionBodies.push(await readJsonBody(request));
        completionHeaders.push(request.headers["x-session"]);
      } catch (error) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end(String(error));
        return;
      }
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
    const socket = process.env.E2E_COMPATIBLE_SOCKET;
    if (socket) server.listen(socket, resolve);
    else server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = process.env.E2E_COMPATIBLE_FIXTURE_URL ?? `http://127.0.0.1:${address.port}/v1`;
    const stamp = Date.now();
    const userName = `Local model ${stamp}`;
    // The pi runtime asks for a model before onboarding finishes; this test connects
    // the fake endpoint from settings instead, so skip that step on the client.
    const skipModelStep = process.env.AGENT_RUNTIME === "pi";
    if (skipModelStep) await page.route("**/rpc/me", fulfillWithoutModelStep);
    await signup(page, `local-model-${stamp}@rakazo.test`, "password12", userName);
    await completeOnboarding(page);
    if (skipModelStep) await page.unroute("**/rpc/me", fulfillWithoutModelStep);

    await openUserSettings(page, "models");
    await openModelConnection(page, "OpenAI-compatible");
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
    await expect(page.getByText("Found 2 models.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await captureScreenshot(page, testInfo, "openai-compatible-model-discovery");

    await expect(page.getByRole("checkbox", { name: LOCAL_MODEL_ID })).toBeChecked();
    await page.getByRole("checkbox", { name: SECOND_MODEL_ID }).check();
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByRole("button", { name: "Add header", exact: true }).click();
    await page.getByRole("textbox", { name: "Header name", exact: true }).fill("x-session");
    await page.getByLabel("Header value", { exact: true }).fill("fake-session-secret");
    await captureScreenshot(page, testInfo, "openai-compatible-header-edit");
    await page.getByRole("checkbox", { name: "Supports thinking" }).check();
    // Room for the bot's required context, so a pi run reaches the fake endpoint.
    await page.getByLabel("Context limit").fill("200000");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(modelConnectionDialog(page, "OpenAI-compatible")).toBeHidden();
    await pickReopenedModel(page);
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("model-role-main").getByTestId("model-role-row-1")).toContainText(
      LOCAL_MODEL_ID,
    );
    await captureScreenshot(page, testInfo, "openai-compatible-connected");
    await page.getByRole("button", { name: "Close model settings" }).click();
    await openUserSettings(page, "models");
    const saved = await manageModelConnection(page, "OpenAI-compatible");
    await expect(saved.getByRole("checkbox", { name: SECOND_MODEL_ID })).toBeChecked();
    await captureScreenshot(page, testInfo, "openai-compatible-multi-model");
    await saved.getByText("Advanced", { exact: true }).click();
    await expect(saved.getByRole("textbox", { name: "Header name", exact: true })).toHaveValue(
      "x-session",
    );
    await expect(saved.getByLabel("Header value", { exact: true })).toHaveValue("");
    await saved.getByRole("group", { name: "Headers", exact: true }).scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "openai-compatible-header-saved");
    const savedCredentials = await rpc<Array<{ modelId?: string; enabledModelIds?: string[] }>>(
      page,
      "models/credentials",
      {},
    );
    expect(
      savedCredentials.find((entry) => entry.modelId === LOCAL_MODEL_ID)?.enabledModelIds,
    ).toEqual([LOCAL_MODEL_ID, SECOND_MODEL_ID]);

    await saved.getByLabel("OpenAI-compatible server URL").fill("");
    await expect(saved.getByRole("button", { name: "Find models" })).toBeDisabled();
    await expect(saved.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await saved.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await expect(saved.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

    // Closing without saving leaves the stored connection as it was.
    await page.keyboard.press("Escape");
    await expect(saved).toBeHidden();
    await page.getByRole("button", { name: "Close model settings" }).click();
    await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
    const settings = page.getByTestId("bot-settings");
    await expect(settings).toBeVisible();
    await expandAdvancedSection(settings.getByTestId("bot-settings-advanced"));
    // The Model select sits inside its wrapping <label>, so the label text includes
    // option copy and getByLabel(..., { exact: true }) misses it. Use the role name.
    const botModel = settings.getByRole("combobox", { name: "Model", exact: true });
    await expect(botModel.locator("option")).toContainText([LOCAL_MODEL_ID, SECOND_MODEL_ID]);
    await botModel.selectOption(`openai-compatible::${SECOND_MODEL_ID}`);
    // Native select popups are outside Playwright's screenshots. Render the
    // same options as an expanded native list for the CI screenshot, then restore.
    // An expanded select is a listbox, so keep a role-independent handle.
    const botModelSelect = settings.locator(`[id="${await botModel.getAttribute("id")}"]`);
    await botModelSelect.evaluate((select: HTMLSelectElement) => {
      select.size = select.options.length;
      select.style.height = "auto";
    });
    await botModelSelect.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "openai-compatible-model-picker");
    await botModelSelect.evaluate((select: HTMLSelectElement) => {
      select.size = 0;
      select.style.removeProperty("height");
    });
    await settings.getByRole("combobox", { name: "Thinking", exact: true }).selectOption("high");
    const botSaved = page.waitForResponse(
      (response) => response.url().includes("/rpc/bots/update") && response.ok(),
    );
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await botSaved;

    if (process.env.AGENT_RUNTIME === "pi") {
      const composer = page.getByPlaceholder(/Message/);
      await composer.fill("Reply with the endpoint verification message.");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("transcript").getByText(LOCAL_MODEL_REPLY)).toBeVisible({
        timeout: 30_000,
      });
      await captureScreenshot(page, testInfo, "openai-compatible-response");
      expect(completionBodies.length).toBeGreaterThan(0);
      expect(completionHeaders.at(-1)).toBe("fake-session-secret");
      expect(completionBodies.at(-1)).toMatchObject({
        model: SECOND_MODEL_ID,
        reasoning_effort: "high",
      });
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

  const mainList = page.getByTestId("model-role-main");
  const connect = await openModelConnection(page, "Scripted");
  // Connecting only asks for credentials; the model is picked afterwards.
  await expect(connect.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0);
  await expect(connect.getByText("Advanced", { exact: true })).toHaveCount(0);
  const apiKeyInput = connect.getByLabel("API key");
  await expect(apiKeyInput).toHaveAttribute("autocomplete", "new-password");
  await apiKeyInput.fill("fake-scripted-key-one");
  await connect.getByRole("button", { name: "Connect API key" }).click();
  await expect(connect).toBeHidden();
  await pickReopenedModel(page, "Scripted runtime (local verification)");
  await expect(mainList.getByTestId("model-role-row-1")).toContainText("Scripted runtime");
  // The output limit lives with the saved connection.
  const limits = await manageModelConnection(page, "Scripted");
  await limits.getByText("Advanced", { exact: true }).click();
  await limits.getByLabel("Maximum output tokens").fill("8192");
  await captureScreenshot(page, testInfo, "builtin-provider-max-tokens");
  await limits.getByRole("button", { name: "Save", exact: true }).click();
  await expect(limits.getByText("Saved.", { exact: true })).toBeVisible();
  const connected = await rpc<Array<{ provider: string; maxTokens?: number }>>(
    page,
    "models/credentials",
    {},
  );
  expect(connected.find((entry) => entry.provider === "scripted")?.maxTokens).toBe(8192);
  await page.keyboard.press("Escape");
  await expect(limits).toBeHidden();
  // A limits-only save keeps the dialog open and confirms inside it.
  const manage = await manageModelConnection(page, "Scripted");
  await manage.getByText("Advanced", { exact: true }).click();
  await manage.getByLabel("Maximum output tokens").fill("16384");
  await manage.getByRole("button", { name: "Save", exact: true }).click();
  await expect(manage.getByText("Saved.", { exact: true })).toBeVisible();
  const updated = await rpc<Array<{ provider: string; maxTokens?: number }>>(
    page,
    "models/credentials",
    {},
  );
  expect(updated.find((entry) => entry.provider === "scripted")?.maxTokens).toBe(16384);
  await page.reload();
  await openUserSettings(page, "models");
  await expect(mainList.getByTestId("model-role-row-1")).toContainText("Scripted runtime");
  await manageModelConnection(page, "Scripted");
  const storedKey = manage.getByLabel("Replace API key");
  await expect(storedKey).toHaveValue("");
  await expect(storedKey).toHaveAttribute("placeholder", "Paste a replacement key");
  await captureScreenshot(page, testInfo, "stored-provider-api-key");
  await manage.getByText("Advanced", { exact: true }).click();
  await expect(manage.getByLabel("Maximum output tokens")).toHaveValue("16384");

  // A saved replacement closes the dialog and keeps the main model.
  await storedKey.fill("fake-scripted-key-two");
  await manage.getByRole("button", { name: "Replace API key" }).click();
  await expect(manage).toBeHidden();
  await expect(mainList.getByTestId("model-role-row-1")).toContainText("Scripted runtime");

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

  const codex = await openModelConnection(page, "ChatGPT subscription", { search: "ChatGPT" });
  await codex.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();

  // The popup is blocked (window.open returned null): the card still carries the
  // code, a copy button, the expiry, and a way to abandon the attempt.
  await expect(codex.getByText("TEST-CODE")).toBeVisible();
  await expect(codex.getByRole("link", { name: "example.com/device" })).toBeVisible();
  await expect(codex.getByText(/code expires in about 15 minutes/)).toBeVisible();
  await captureScreenshot(page, testInfo, "oauth-device-code-card");
  await codex.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(codex.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("TEST-CODE");

  const cancelledByButton = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await codex.getByRole("button", { name: "Cancel", exact: true }).click();
  await cancelledByButton;
  await expect(codex.getByText("TEST-CODE")).toBeHidden();

  // A canceled attempt leaves sign-in reusable.
  await codex.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();
  await expect(codex.getByText("TEST-CODE")).toBeVisible();

  // Closing the dialog abandons the attempt.
  const cancelled = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await page.keyboard.press("Escape");
  await expect(codex).toBeHidden();
  await cancelled;
  expect(finishRequests).toBe(0);
  await manageModelConnection(page, "Scripted");
  await manage.getByLabel("Replace API key").fill("fake-scripted-key-three");
  await expect(manage.getByRole("button", { name: "Replace API key" })).toBeEnabled();
  await expect(page.getByText("TEST-CODE")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(manage).toBeHidden();

  // A finished sign-in closes the dialog and reopens the picker; the provider no longer
  // offers to connect.
  oauthReady = true;
  await openModelConnection(page, "ChatGPT subscription", { search: "ChatGPT" });
  await codex.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();
  await expect(codex).toBeHidden();
  const reopened = page.getByRole("combobox", { name: "Search models" });
  await expect(reopened).toBeVisible();
  await reopened.fill("ChatGPT");
  await expect(modelConnectOption(page, "ChatGPT subscription")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(reopened).toBeHidden();

  // Disconnect removes the credential and empties the main model slot.
  await manageModelConnection(page, "Scripted");
  await manage.getByRole("button", { name: "Disconnect", exact: true }).click();
  const confirmDisconnect = page.getByRole("alertdialog");
  await expect(
    confirmDisconnect.getByRole("heading", { name: "Disconnect Scripted?" }),
  ).toBeVisible();
  await confirmDisconnect.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(manage).toBeHidden();
  await expect(page.getByText(/Disconnected Scripted/)).toBeVisible();
  const afterDisconnect = await rpc<Array<{ provider: string }>>(page, "models/credentials", {});
  expect(afterDisconnect.some((entry) => entry.provider === "scripted")).toBe(false);
  await expect(mainList.getByTestId("model-role-default")).toBeVisible();
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
  await expect(page.getByTestId("model-role-main").getByTestId("model-role-default")).toContainText(
    "Claude Haiku",
  );

  // The server already pays for this provider, so a personal key stays a choice.
  const dialog = await openModelConnection(page, "Amazon Bedrock");
  const serverNote = dialog.getByText(
    "Uses this server's own AWS IAM credentials to access Amazon Bedrock.",
  );
  await expect(serverNote).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Connect API key" })).toBeVisible();
  await captureScreenshot(page, testInfo, "model-settings-server-credentials");
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
  const haiku = (
    await rpc<Array<{ provider: string; id: string; label: string }>>(page, "models/list", {})
  ).find((entry) => entry.provider === provider && entry.id === modelId);
  if (!haiku) throw new Error("catalog has no Bedrock Claude Haiku model");
  await openUserSettings(page, "models");
  const mainList = page.getByTestId("model-role-main");
  await expect(mainList.getByTestId("model-role-default")).toContainText(/Claude Haiku/);
  // The key from the other space already offers its model in this space's picker.
  await mainList.getByRole("button", { name: "Change Main model", exact: true }).click();
  const option = page
    .getByRole("listbox", { name: "Model options" })
    .getByRole("option", { name: haiku.label, exact: true })
    .first();
  await expect(option).toBeVisible();
  await captureScreenshot(page, testInfo, "model-settings-server-credentials-connected-key");
  const saved = page.waitForRequest("**/rpc/models/setRole");
  await option.click();
  const request = await saved;
  expect(request.postDataJSON().json).toMatchObject({
    role: "main",
    primary: { provider, modelId },
  });
  expect(request.headers()["x-rakazo-space-id"]).not.toBe(otherSpace.id);
  await expect(mainList.getByTestId("model-role-row-1")).toContainText(haiku.label);
  await expect(mainList.getByTestId("model-role-default")).toHaveCount(0);
  await expect
    .poll(() => rpc(page, "me", {}))
    .toMatchObject({
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

  const primary = page.getByTestId("model-role-main").getByTestId("model-role-row-1");
  const rowOptions = primary.getByRole("button", { name: / options$/ });

  // A non-reasoning main model never offers the control.
  const scripted = await openModelConnection(page, "Scripted");
  await scripted.getByLabel("API key").fill("fake-scripted-key");
  await scripted.getByRole("button", { name: "Connect API key" }).click();
  await expect(scripted).toBeHidden();
  await pickReopenedModel(page);
  await expect(primary).toContainText("Scripted");
  await rowOptions.click();
  await expect(page.getByRole("menuitem", { name: "Manage Scripted", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Thinking", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The level chosen from the main model's menu is stored with the connection's model.
  const anthropic = await openModelConnection(page, "Anthropic");
  await anthropic.getByLabel("API key").fill("fake-anthropic-key");
  await anthropic.getByRole("button", { name: "Connect API key" }).click();
  await expect(anthropic).toBeHidden();
  // Connecting keeps the current main model; choose an Anthropic model in its reopened picker.
  await page
    .getByRole("listbox", { name: "Model options" })
    .getByRole("option")
    .filter({ hasText: /Claude/ })
    .first()
    .click();
  await expect(primary).toContainText("Claude");
  await expect(primary.getByText(/^Thinking: /)).toHaveCount(0);
  await rowOptions.click();
  await page.getByRole("menuitem", { name: "Thinking", exact: true }).click();
  const high = page.getByRole("menuitemradio", { name: "High", exact: true });
  await expect(page.getByRole("menuitemradio", { name: "Default", exact: true })).toBeChecked();
  await captureScreenshot(page, testInfo, "catalog-model-thinking");
  await high.click();
  // The main model row surfaces the effective effort while the model can think.
  await expect(primary.getByText("Thinking: High", { exact: true })).toBeVisible();

  await expect
    .poll(async () => {
      const credentials = await rpc<Array<{ provider: string; thinkingLevel?: string | null }>>(
        page,
        "models/credentials",
        {},
      );
      return credentials.find((entry) => entry.provider === "anthropic")?.thinkingLevel;
    })
    .toBe("high");

  // The level persists across reloads while the same model stays selected.
  await page.reload();
  await openUserSettings(page, "models");
  await expect(primary.getByText("Thinking: High", { exact: true })).toBeVisible();

  // The stored level is bound to the saved model: choosing another main model clears
  // the old level instead of leaking it.
  await primary.getByRole("button", { name: /^Change / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill("Claude Opus 4.8");
  await page
    .getByRole("listbox", { name: "Model options" })
    .getByRole("option", { name: "Claude Opus 4.8", exact: true })
    .first()
    .click();
  await expect(primary).toContainText("Claude Opus 4.8");
  await expect(primary.getByText(/^Thinking: /)).toHaveCount(0);
  await expect
    .poll(async () => {
      const updated = await rpc<Array<{ provider: string; thinkingLevel?: string | null }>>(
        page,
        "models/credentials",
        {},
      );
      return updated.find((entry) => entry.provider === "anthropic")?.thinkingLevel;
    })
    .toBeUndefined();
});

test("chat settings search a long model list", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `chat-model-search-${stamp}@rakazo.test`, "password12", `Search ${stamp}`);
  await completeOnboarding(page);

  const catalog = await rpc<
    Array<{
      provider: string;
      providerName?: string;
      id: string;
      label: string;
      placeholder?: boolean;
    }>
  >(page, "models/list", {});
  const openRouter = catalog.filter(
    (entry) => entry.provider === "openrouter" && !entry.placeholder,
  );
  expect(openRouter.length).toBeGreaterThan(10);
  const target = openRouter.find((entry) => entry.id.startsWith("anthropic/")) ?? openRouter[0]!;
  // The harness verifies this fake key offline before the catalog becomes available.
  await rpc(page, "models/connect", {
    provider: "openrouter",
    apiKey: "fake-openrouter-key",
    modelId: target.id,
  });

  await page.reload();
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  await expandAdvancedSection(settings.getByTestId("bot-settings-advanced"));
  const model = settings.getByRole("button", { name: "Model", exact: true });
  await expect(model).toHaveText(/^Space default/);
  await model.click();

  const search = page.getByRole("combobox", { name: "Search models" });
  await expect(search).toBeFocused();
  const options = page.locator('[data-slot="command-list"]').getByRole("option");
  await expect(options).toHaveCount(openRouter.length + 1);
  // Rows show names, so this provider prefix can only match the model ids.
  const anthropicIds = openRouter.filter((entry) => entry.id.includes("anthropic/")).length;
  expect(anthropicIds).toBeGreaterThan(0);
  await search.fill("ANTHROPIC/");
  await expect(options).toHaveCount(anthropicIds);
  await captureScreenshot(page, testInfo, "chat-settings-model-search");

  await search.fill("no model is called this");
  await expect(options).toHaveCount(0);
  await expect(page.getByText("No matching models")).toBeVisible();
  await captureScreenshot(page, testInfo, "chat-settings-model-search-empty");

  await search.fill(target.id);
  const targetLabel = `${target.providerName ?? target.provider} · ${target.label}`;
  await page
    .locator('[data-slot="command-list"]')
    .getByRole("option", { name: targetLabel, exact: true })
    .click();
  await expect(search).toBeHidden();
  await expect(model).toHaveText(targetLabel);
  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await saved;
  const bots = await rpc<Array<{ name: string; modelProvider?: string; modelId?: string }>>(
    page,
    "bots/list",
    {},
  );
  expect(bots.find((bot) => bot.name === "Chief")).toMatchObject({
    modelProvider: "openrouter",
    modelId: target.id,
  });
});

test("Ollama Cloud preset saves an OpenAI-compatible connection", async ({ page }, testInfo) => {
  await signup(page, `ollama-preset-${Date.now()}@rakazo.test`, "password12", "Model Preview");
  await completeOnboarding(page);
  await openUserSettings(page, "models");
  const dialog = await openModelConnection(page, "Ollama Cloud", { search: "Ollama" });
  await expect(dialog.getByLabel("OpenAI-compatible server URL", { exact: true })).toHaveValue(
    "https://ollama.com/v1",
  );
  await dialog.getByPlaceholder("Ollama API key").fill("rejected-fixture-key");
  await dialog.getByRole("button", { name: "Find models", exact: true }).click();
  await expect(
    dialog.getByText("API key was rejected by the provider.", { exact: true }),
  ).toBeVisible();
  await dialog.getByPlaceholder("Ollama API key").fill("fake-fixture-key");
  await dialog.getByRole("button", { name: "Find models", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "fixture-model", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await pickReopenedModel(page);
  await expect
    .poll(async () => {
      const credentials = await rpc<
        Array<{ provider: string; baseUrl?: string; modelId?: string }>
      >(page, "models/credentials", {});
      return credentials;
    })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openai-compatible",
          baseUrl: "https://ollama.com/v1",
          modelId: "fixture-model",
        }),
      ]),
    );
  await captureScreenshot(page, testInfo, "ollama-preset");
});

test("a Claude subscription folds the key form and bots move to the space default", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const stamp = Date.now();
  await signup(page, `subscription-${stamp}@rakazo.test`, "password12", "Subscription Preview");
  await completeOnboarding(page);
  const catalog = await rpc<Array<{ provider: string; id: string; placeholder?: boolean }>>(
    page,
    "models/list",
    {},
  );
  const claude = catalog.find((entry) => entry.provider === "anthropic" && !entry.placeholder);
  if (!claude) throw new Error("catalog has no Anthropic model");
  const pinned = new Map<string, string>();
  for (const name of ["Archie", "Inbox"]) {
    const bot = await rpc<{ id: string }>(page, "bots/create", {
      name,
      title: "",
      description: "",
      notifyOnFinish: true,
    });
    pinned.set(bot.id, name);
  }
  // A signed-in subscription and bots with their own model, without a live provider.
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    Object.assign(body.json, {
      needsModel: false,
      defaultProvider: "anthropic",
      defaultModel: claude.id,
    });
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "cred-claude",
            provider: "anthropic",
            label: "Anthropic",
            hasKey: false,
            isDefault: true,
            modelId: claude.id,
            authKind: "oauth",
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/bots/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Array<{ id: string }> };
    body.json = body.json.map((bot) =>
      pinned.has(bot.id) ? { ...bot, modelProvider: "anthropic", modelId: claude.id } : bot,
    );
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/bots/update", async (route) => {
    pinned.delete((route.request().postDataJSON() as { json: { botId: string } }).json.botId);
    await route.continue();
  });

  // The main list is stored server-side; show the signed-in subscription as its model.
  await page.route("**/rpc/models/role", async (route) => {
    const { json } = route.request().postDataJSON() as { json: { role: string } };
    if (json.role !== "main") return route.continue();
    await route.fulfill({
      json: { json: { primary: { provider: "anthropic", modelId: claude.id }, backups: [] } },
    });
  });

  await openUserSettings(page, "models");
  const bots = page.getByTestId("space-bots-model");
  await expect(bots).toContainText("2 bots have their own model: Archie, Inbox");
  const dialog = await manageModelConnection(page, "Claude subscription");
  await expect(dialog.locator("#model-api-key")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "subscription-key-folded-and-bot-models");

  await dialog.getByRole("button", { name: "Or paste an API key" }).click();
  await expect(dialog.getByLabel("Or paste an API key")).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Connect API key" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await bots.getByRole("button", { name: "Use space default" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(
    confirm.getByRole("heading", { name: "Switch 2 bots to the space default?" }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-models-confirm");
  await confirm.getByRole("button", { name: "Switch", exact: true }).click();
  await expect(bots).toContainText("2 bots now use the space default.");
  await expect(bots.getByRole("button", { name: "Use space default" })).toHaveCount(0);
});
