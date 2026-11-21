import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ModelRoleSettings } from "@rakazo/contracts";
import {
  captureScreenshot,
  chooseOption,
  completeOnboarding,
  manageModelConnection,
  modelConnectionDialog,
  openBotSettings,
  openModelConnection,
  openUserSettings,
  pickReopenedModel,
  rpc,
  signup,
} from "../helpers/helpers";

const LOCAL_MODEL_ID = "rakazo-e2e-local";
const SECOND_MODEL_ID = "rakazo-e2e-second";
const LOCAL_MODEL_REPLY = "OpenAI-compatible endpoint verified end to end.";

test.afterEach(async ({ page }) => {
  // Finish intercepted responses before the browser context is disposed.
  await page.unrouteAll({ behavior: "wait" });
});

test("model settings cleanup frames", { tag: "@nightly" }, async ({ page }, testInfo) => {
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
  await expect(mainList.getByTestId("model-role-default")).toContainText("Connect a model");
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
  await expect(dialog.getByText("Zero data retention", { exact: true })).toBeVisible();
  const retention = dialog.locator("[role='switch']");
  await expect(retention).toHaveAttribute("aria-checked", "false");
  await retention.click();
  await expect(retention).toHaveAttribute("aria-checked", "true");
  await captureScreenshot(page, testInfo, "model-settings-cleanup-1b-zero-data-retention");
  providerConnected = true;
  await dialog.getByRole("button", { name: "Connect API key", exact: true }).click();
  await expect(dialog).toBeHidden();
  const connected = await rpc<Array<{ provider: string; zeroDataRetention?: boolean }>>(
    page,
    "models/credentials",
    {},
  );
  expect(connected.find((credential) => credential.provider === "openrouter")).toMatchObject({
    zeroDataRetention: true,
  });
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
  // biome-ignore lint/performance/useDomNodeTextContent: Playwright locator.innerText() returns rendered text as a string, not a DOM node.
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
  // biome-ignore lint/performance/useDomNodeTextContent: Playwright locator.innerText() returns rendered text as a string, not a DOM node.
  const backupLabel = (await backupItem.innerText()).trim();
  await backupItem.click();
  await expect(options).toBeHidden();
  await expect(mainList.getByTestId("model-role-row-2")).toContainText(backupLabel);
  await expect.poll(async () => (await rpc<unknown[]>(page, "models/backups", {})).length).toBe(1);
  await mainList.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "model-settings-cleanup-5-backup-added");

  // A bot that keeps its own model sits behind a small count by the Main model heading.
  await page.route("**/rpc/bots/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Array<Record<string, unknown>> };
    const [first, ...rest] = body.json;
    const pinned = first ? [{ ...first, modelProvider: "openrouter", modelId: firstModel }] : [];
    await route.fulfill({ response, json: { ...body, json: [...pinned, ...rest] } });
  });
  await page.reload();
  await openUserSettings(page, "models");
  const bots = page.getByTestId("space-bots-model");
  await expect(bots).toHaveText("1");
  await captureScreenshot(page, testInfo, "model-settings-cleanup-6-bot-own-model");
  await bots.click();
  await expect(page.getByRole("button", { name: "Use main model", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "model-settings-cleanup-7-bot-own-model-open");
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
        JSON.stringify({
          object: "list",
          data: [
            { id: LOCAL_MODEL_ID },
            { id: SECOND_MODEL_ID },
            ...Array.from({ length: 9 }, (_, index) => ({ id: `fixture-extra-${index}` })),
          ],
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      try {
        completionBodies.push(await readJsonBody(request));
        completionHeaders.push(request.headers["x-session"]);
      } catch {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("Invalid request body");
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
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    const providerSearch = page.getByRole("combobox", { name: "Add provider", exact: true });
    await expect(providerSearch).toBeVisible();
    await providerSearch.fill("compatible");
    await captureScreenshot(page, testInfo, "add-provider-list-search");
    await providerSearch.press("Escape");
    await openModelConnection(page, "OpenAI-compatible");
    await page.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await page.getByLabel("Model id").fill("manual-model-not-listed");

    await expect(page.getByLabel("Model id")).toHaveValue("manual-model-not-listed");
    await expect(
      page.getByText("The server didn’t list this model.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Use a found model" }).click();
    const discoveredModels = page.getByRole("combobox", { name: "Models from server" });
    await expect(discoveredModels).toHaveText(LOCAL_MODEL_ID);
    await chooseOption(discoveredModels, "Other model…");
    await expect(page.getByLabel("Model id")).toBeVisible();
    await page.getByRole("button", { name: "Use a found model" }).click();
    await expect(discoveredModels).toHaveText(LOCAL_MODEL_ID);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await captureScreenshot(page, testInfo, "openai-compatible-model-discovery");

    const enabledModels = page.getByRole("button", { name: "Enabled models", exact: true });
    await enabledModels.click();
    const modelSearch = page.getByRole("textbox", { name: "Search models", exact: true });
    await expect(modelSearch).toBeVisible();
    await captureScreenshot(page, testInfo, "compatible-model-list-search");
    await modelSearch.fill("fixture-extra-8");
    await expect(page.getByText("1 selected model is hidden by your search.")).toBeVisible();
    await captureScreenshot(page, testInfo, "compatible-model-list-search-filtered");
    await modelSearch.fill("");
    await expect(page.getByRole("checkbox", { name: LOCAL_MODEL_ID })).toBeChecked();
    await page.getByRole("checkbox", { name: SECOND_MODEL_ID }).check();
    await enabledModels.click();
    await expect(modelSearch).toBeHidden();
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByRole("button", { name: "Add header", exact: true }).press("Enter");
    await page.getByRole("textbox", { name: "Header name", exact: true }).fill("x-session");
    await page.getByLabel("Header value", { exact: true }).fill("fake-session-secret");
    await captureScreenshot(page, testInfo, "openai-compatible-header-edit");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(modelConnectionDialog(page, "OpenAI-compatible")).toBeHidden();
    await pickReopenedModel(page);
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("model-role-main").getByTestId("model-role-row-1")).toContainText(
      LOCAL_MODEL_ID,
    );
    await captureScreenshot(page, testInfo, "openai-compatible-connected");
    // A model's own settings open from its row: this endpoint's model thinks.
    await page
      .getByTestId("model-role-main")
      .getByTestId("model-role-row-1")
      .getByRole("button", { name: / options$/ })
      .click();
    await page.getByRole("menuitem", { name: "Manage model", exact: true }).click();
    const modelSettings = page.getByTestId("model-settings-page");
    await expect(modelSettings).toContainText(LOCAL_MODEL_ID);
    await modelSettings.getByRole("checkbox", { name: "Supports thinking" }).check();
    await modelSettings.getByLabel("Context limit").fill("200000");
    await modelSettings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(modelSettings.getByText("Saved.", { exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, "model-settings-page");
    await modelSettings.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "Close model settings" }).click();
    await openUserSettings(page, "models");
    const saved = await manageModelConnection(page, "OpenAI-compatible");
    await captureScreenshot(page, testInfo, "model-provider-models");
    await saved.getByRole("button", { name: "Enabled models", exact: true }).click();
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
    await expect(saved.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await saved.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await expect(saved.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

    await saved.getByRole("button", { name: "Back", exact: true }).click();
    await expect(saved).toBeHidden();
    await page.getByRole("button", { name: "Close model settings" }).click();
    await openBotSettings(page);
    const settings = page.getByTestId("bot-settings");
    // The model row names the model in use and opens the list; each change saves at once.
    await settings.getByRole("button", { name: /^Model/ }).click();
    const localModel = page.getByRole("option", { name: LOCAL_MODEL_ID });
    await expect(localModel).toBeVisible();
    await expect(page.getByRole("option", { name: SECOND_MODEL_ID })).toBeVisible();
    await captureScreenshot(page, testInfo, "openai-compatible-model-picker");
    const modelSaved = page.waitForResponse(
      (response) => response.url().includes("/rpc/bots/update") && response.ok(),
    );
    await localModel.click();
    await modelSaved;
    await expect(settings.getByRole("button", { name: /^Model/ })).toContainText(LOCAL_MODEL_ID);
    const botSaved = page.waitForResponse(
      (response) => response.url().includes("/rpc/bots/update") && response.ok(),
    );
    await chooseOption(settings.getByRole("combobox", { name: "Thinking", exact: true }), "High");
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
        model: LOCAL_MODEL_ID,
        reasoning_effort: "high",
      });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a rejected subscription sign-in asks to sign in again", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `reconnect-${stamp}@rakazo.test`, "password12", "Reconnect Preview");
  await completeOnboarding(page);
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
            authKind: "oauth",
            reconnectRequired: true,
          },
          {
            id: "cred-api-key",
            provider: "anthropic",
            label: "Anthropic",
            hasKey: true,
            isDefault: false,
            authKind: "api_key",
          },
        ],
      },
    }),
  );

  await openUserSettings(page, "models");
  await expect(page.getByTestId("model-provider-cred-claude")).toContainText("Sign in again");
  await expect(page.getByTestId("model-provider-cred-claude")).toContainText("Claude subscription");
  const apiKey = page.getByTestId("model-provider-cred-api-key");
  await expect(apiKey).toContainText("Anthropic");
  await expect(apiKey).not.toContainText("Claude subscription");
  await captureScreenshot(page, testInfo, "model-settings-reconnect-required");
  // The connection's page offers sign-in only because it expired; rename and disconnect end it.
  await page.getByTestId("model-provider-cred-claude").getByRole("button").click();
  const connection = page.getByTestId("model-provider-page");
  await expect(
    connection.getByRole("heading", { name: "Claude subscription", exact: true }),
  ).toBeVisible();
  await expect(connection.getByRole("button", { name: "Sign in again" })).toBeVisible();
  await expect(connection.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(connection.getByRole("button", { name: "Test connection" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "model-connection-page");
});

test("a refused private model server names the setting that allows it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `private-model-${stamp}@rakazo.test`, "password12", "Private Model Preview");
  await completeOnboarding(page);
  // The e2e server allows private endpoints, so replay the refusal a default install sends.
  const message =
    "Private model endpoints need MCP_ALLOW_PRIVATE_ENDPOINT=true on the API and worker.";
  await page.route("**/rpc/models/probeOpenAiCompatible", (route) =>
    route.fulfill({
      status: 400,
      json: { json: { defined: false, code: "BAD_REQUEST", status: 400, message } },
    }),
  );

  await openUserSettings(page, "models");
  const dialog = await openModelConnection(page, "OpenAI-compatible");
  await dialog.getByLabel("OpenAI-compatible server URL").fill("http://192.168.1.20:1234/v1");
  await expect(dialog.getByText(message, { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "openai-compatible-private-endpoint-refused");
});

test("project-scoped model connection keeps its routing after reopening", async ({
  page,
}, testInfo) => {
  await signup(page, `model-project-${Date.now()}@rakazo.test`, "password12", "Model Preview");
  await completeOnboarding(page);
  await openUserSettings(page, "models");
  const dialog = await openModelConnection(page, "Google Vertex AI");
  await expect(dialog.getByLabel("Project ID", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Region", { exact: true })).toHaveValue("global");
  await dialog.getByLabel("Project ID", { exact: true }).fill("example-project");
  await dialog.getByLabel("API key", { exact: true }).fill("fake-vertex-api-key");
  await captureScreenshot(page, testInfo, "model-project-connection");
  await dialog.getByRole("button", { name: "Connect API key", exact: true }).click();
  await expect(dialog).toBeHidden();
  const credentials = await rpc<Array<{ provider: string; projectId?: string; region?: string }>>(
    page,
    "models/credentials",
    {},
  );
  expect(credentials.find((credential) => credential.provider === "google-vertex")).toMatchObject({
    projectId: "example-project",
    region: "global",
  });
  await pickReopenedModel(page, "Gemini 4 Hydrogen");
  const saved = await manageModelConnection(page, "Google Vertex AI");
  await expect(saved.getByLabel("Project ID", { exact: true })).toHaveValue("example-project");
  await expect(saved.getByLabel("Region", { exact: true })).toHaveValue("global");
});

test("model funding connections", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `model-funding-${stamp}@rakazo.test`, "password12", "Model Settings");
  await completeOnboarding(page);
  const model = {
    provider: "example",
    providerName: "Example",
    id: "reasoning-example",
    label: "Reasoning model",
    billing: "",
    creditOfferingId: "offering-example",
  };
  let settings: ModelRoleSettings = {
    primary: { provider: model.provider, modelId: model.id, credentialId: "personal-example" },
    backups: [],
  };
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "personal-example",
            provider: model.provider,
            label: "Personal",
            hasKey: true,
            isDefault: true,
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/models/forRole", (route) => route.fulfill({ json: { json: [model] } }));
  await page.route("**/rpc/models/role", (route) => route.fulfill({ json: { json: settings } }));
  await page.route("**/rpc/models/setRole", async (route) => {
    const { json } = route.request().postDataJSON() as { json: Partial<ModelRoleSettings> };
    settings = { ...settings, ...json };
    await route.fulfill({ json: { json: settings } });
  });
  await page.reload();
  await openUserSettings(page, "models");
  const main = page.getByTestId("model-role-main");
  await main.getByRole("button", { name: "Change Reasoning model", exact: true }).click();
  await expect(page.locator("[cmdk-group]").filter({ hasText: "BotONE credits" })).toBeVisible();
  await captureScreenshot(page, testInfo, "model-funding-connections-picker");
  await page
    .locator("[cmdk-group]")
    .filter({ hasText: "BotONE credits" })
    .getByRole("option", { name: "Reasoning model", exact: true })
    .click();
  await expect(main.getByTestId("model-role-row-1")).toContainText("BotONE credits");
  expect(settings.primary).toEqual({
    provider: model.provider,
    modelId: model.id,
    creditOfferingId: model.creditOfferingId,
  });
  await captureScreenshot(page, testInfo, "model-funding-connections-credits");
  await main.getByRole("button", { name: "Change Reasoning model", exact: true }).click();
  await page
    .locator("[cmdk-group]")
    .filter({ hasText: "Example (Personal)" })
    .getByRole("option", { name: "Reasoning model", exact: true })
    .click();
  await expect(main.getByTestId("model-role-row-1")).toContainText("Example (Personal)");
  expect(settings.primary).toEqual({
    provider: model.provider,
    modelId: model.id,
    credentialId: "personal-example",
  });
});

test("an approval default the deployment pays for reads as included", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `approval-included-${stamp}@rakazo.test`, "password12", "Model Settings");
  await completeOnboarding(page);
  const included = {
    provider: "example",
    providerName: "Example",
    id: "reviewer-example",
    label: "Reviewer",
    billing: "",
    protocol: "decisions" as const,
  };
  const other = {
    provider: "example",
    providerName: "Example",
    id: "judge-example",
    label: "Judge",
    billing: "",
    creditOfferingId: "offering-example",
  };
  let settings: ModelRoleSettings = { primary: null, backups: [] };
  const view = () => ({
    ...settings,
    deploymentPrimary: { provider: included.provider, modelId: included.id },
    deploymentIncluded: true,
  });
  const approval = (route: Route) =>
    (route.request().postDataJSON() as { json: { role: string } }).json.role === "approval";
  await page.route("**/rpc/models/forRole", (route) =>
    approval(route) ? route.fulfill({ json: { json: [included, other] } }) : route.continue(),
  );
  await page.route("**/rpc/models/role", (route) =>
    approval(route) ? route.fulfill({ json: { json: view() } }) : route.continue(),
  );
  await page.route("**/rpc/models/setRole", async (route) => {
    if (!approval(route)) return route.continue();
    const { json } = route.request().postDataJSON() as { json: Partial<ModelRoleSettings> };
    settings = { ...settings, ...json };
    await route.fulfill({ json: { json: view() } });
  });
  await page.reload();
  await openUserSettings(page, "models");
  const section = page.getByTestId("model-role-approval");
  await expect(section.getByTestId("model-role-default")).toHaveText("ReviewerIncluded");
  await captureScreenshot(page, testInfo, "model-settings-approval-included");

  await section.getByRole("button", { name: "Change Approval model", exact: true }).click();
  await page.getByRole("option", { name: "Judge", exact: true }).click();
  await expect(section.getByTestId("model-role-row-1")).toContainText("Judge");
  await section.getByRole("button", { name: "Change Judge", exact: true }).click();
  const back = page.getByRole("option").filter({ hasText: "Reviewer" });
  await expect(back).toHaveText("ReviewerIncluded");
  await captureScreenshot(page, testInfo, "model-settings-approval-included-picker");
  await back.click();
  await expect(section.getByTestId("model-role-default")).toHaveText("ReviewerIncluded");
  expect(settings.primary).toBeNull();
});

test("a device-code sign-in shows its setup and code before opening the page", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    body.json.needsModel = true;
    body.json.needsSignupSurvey = false;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/models/beginOAuth", (route) =>
    route.fulfill({
      json: {
        json: {
          mode: "device-code",
          loginId: "login-e2e",
          provider: "openai-codex",
          verificationUri: "https://auth.example.test/device",
          userCode: "TI9B-J5KAM",
          expiresInSeconds: 900,
        },
      },
    }),
  );
  await page.route("**/rpc/models/completeOAuth", (route) =>
    route.fulfill({ json: { json: { status: "pending" } } }),
  );
  await signup(page, `device-code-${stamp}@rakazo.test`, "password12", "Device Code Preview");
  await chooseOption(page.getByLabel("Provider", { exact: true }), "ChatGPT subscription");
  await expect(
    page.getByText("Turn on device code sign-in in ChatGPT security settings"),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open settings" })).toBeVisible();
  await captureScreenshot(page, testInfo, "onboarding-device-code-setup");
  const opened = page.waitForEvent("popup", { timeout: 1000 }).catch(() => null);
  await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(page.getByText("TI9B-J5KAM")).toBeVisible();
  // The page opens only when the person asks, so they never land there without the code.
  expect(await opened).toBeNull();
  await expect(page.getByRole("link", { name: "Copy code and open" })).toHaveAttribute(
    "href",
    "https://auth.example.test/device",
  );
  await captureScreenshot(page, testInfo, "onboarding-device-code-sign-in");
});

test("a pasted-code sign-in opens its page from a click and then takes the code", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    body.json.needsModel = true;
    body.json.needsSignupSurvey = false;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/models/beginOAuth", (route) =>
    route.fulfill({
      json: {
        json: {
          mode: "auth-url",
          loginId: "login-e2e",
          provider: "anthropic",
          verificationUri: "https://auth.example.test/oauth/authorize?state=e2e",
          expiresInSeconds: 900,
        },
      },
    }),
  );
  await page.route("**/rpc/models/completeOAuth", (route) =>
    route.fulfill({ json: { json: { status: "pending" } } }),
  );
  await signup(page, `paste-code-${stamp}@rakazo.test`, "password12", "Paste Code Preview");
  await chooseOption(page.getByLabel("Provider", { exact: true }), "Claude subscription");
  await page.getByRole("button", { name: "Sign in with Claude" }).click();
  const open = page.getByRole("link", { name: "Open auth.example.test" });
  await expect(open).toHaveAttribute("href", "https://auth.example.test/oauth/authorize?state=e2e");
  await expect(page.getByRole("textbox", { name: "Code from auth.example.test" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeHidden();
  await captureScreenshot(page, testInfo, "onboarding-paste-code-sign-in");
});
