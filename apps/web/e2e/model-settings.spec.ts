import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const LOCAL_MODEL_ID = "rakazo-e2e-local";
const LOCAL_MODEL_REPLY = "OpenAI-compatible endpoint verified end to end.";

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

    await page.getByRole("button", { name: new RegExp(userName) }).click();
    await page.getByRole("button", { name: "Models", exact: true }).click();
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
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
    await captureScreenshot(page, testInfo, "openai-compatible-model-discovery");

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.getByRole("button", { name: /OpenAI-compatible/ })).toContainText(
      "Connected",
    );
    await captureScreenshot(page, testInfo, "openai-compatible-connected");

    await page.getByLabel("OpenAI-compatible server URL").fill("");
    await expect(page.getByRole("button", { name: "Find models" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await page.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();

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

test("model settings connect, replace, and cancel provider authentication", async ({ page }) => {
  const stamp = Date.now();
  const userName = `Models ${stamp}`;
  await signup(page, `models-${stamp}@rakazo.test`, "password12", userName);
  await expect(page.getByLabel("API key")).toHaveAttribute("autocomplete", "new-password");
  await completeOnboarding(page);

  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close model settings" })).toBeVisible();

  const providerSearch = page.getByPlaceholder("Search providers");
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(/Scripted runtime/);
  const apiKeyInput = page.getByLabel("API key");
  await expect(apiKeyInput).toHaveAttribute("autocomplete", "new-password");
  await apiKeyInput.fill("fake-scripted-key-one");
  await page.getByRole("button", { name: "Connect API key" }).click();
  await expect(page.getByText(/Connected and using Scripted runtime/)).toBeVisible();

  await page.getByLabel("Replace API key").fill("fake-scripted-key-two");
  await page.getByRole("button", { name: "Replace API key" }).click();
  await expect(page.getByText(/Connected and using Scripted runtime/)).toBeVisible();

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
      body: JSON.stringify({ json: { status: "pending" } }),
    });
  });
  await page.evaluate(() => {
    window.open = () => null;
  });
  let finishRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/models/finishOAuth")) finishRequests += 1;
  });

  await providerSearch.fill("openai-codex");
  await page
    .getByRole("button", { name: /ChatGPT Plus\/Pro/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();
  await expect(page.getByText("Waiting for sign-in…")).toBeVisible();

  const cancelled = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await cancelled;
  expect(finishRequests).toBe(0);
  await page.getByLabel("Replace API key").fill("fake-scripted-key-three");
  await expect(page.getByRole("button", { name: "Replace API key" })).toBeEnabled();
  await expect(page.getByText("Waiting for sign-in…")).toBeHidden();
});
