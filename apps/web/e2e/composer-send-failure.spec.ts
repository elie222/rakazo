import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Routine, ThreadMessage } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

async function openComposer(page: Page, prefix: string) {
  await signup(page, `${prefix}-${Date.now()}@rakazo.test`, "password12", "Draft Keeper");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toBeVisible();
  return composer;
}

test("a failed send keeps the message and its attachment in the composer", async ({
  page,
}, testInfo) => {
  const composer = await openComposer(page, "send-failure");
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("meeting notes"),
  });
  const removeAttachment = page.getByRole("button", { name: "Remove notes.txt" });
  await expect(removeAttachment).toBeVisible();

  await page.route("**/rpc/threads/send", (route) => route.abort("internetdisconnected"));
  await composer.fill("message that fails to send");
  await composer.press("Enter");

  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(composer).toHaveValue("message that fails to send");
  await expect(removeAttachment).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-send-failure-keeps-draft");

  await page.unroute("**/rpc/threads/send");
  await composer.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("message that fails to send", { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(removeAttachment).toBeHidden();
  await expect(page.getByTestId("composer-error")).toBeHidden();
});

test("the missing-model send error opens model settings", async ({ page }, testInfo) => {
  const composer = await openComposer(page, "send-needs-model");
  await page.route("**/rpc/threads/send", (route) =>
    route.fulfill({
      status: 400,
      json: {
        json: {
          defined: false,
          code: "BAD_REQUEST",
          status: 400,
          message: "Connect a model to start a run.",
        },
      },
    }),
  );
  await composer.fill("what can you do?");
  await composer.press("Enter");

  const link = page.getByRole("button", { name: "Connect a model to start a run.", exact: true });
  await expect(link).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-send-needs-model");

  await link.click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: "Advanced", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(settings.getByRole("combobox", { name: "Model", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(composer).toHaveValue("what can you do?");
});

test("a failed send leaves a newer draft alone", async ({ page }) => {
  const composer = await openComposer(page, "send-failure-newer");
  let failSend = () => {};
  const sendFailed = new Promise<void>((resolve) => {
    failSend = resolve;
  });
  await page.route("**/rpc/threads/send", async (route) => {
    await sendFailed;
    await route.abort("internetdisconnected");
  });

  await composer.fill("first message");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await composer.fill("newer draft");
  failSend();

  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(composer).toHaveValue("newer draft");
});

async function createRoutine(page: Page, name: string) {
  return rpc<Routine>(page, "routines/create", {
    botId: activeBotId(page),
    name,
    prompt: "Summarize today",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: false,
    notify: false,
  });
}

async function mentionRoutine(page: Page, composer: Locator, name: string) {
  await composer.pressSequentially(`@${name.slice(0, 4)}`);
  await expect(page.getByRole("option", { name: `@${name}` })).toBeVisible();
  await composer.press("Enter");
}

test("a routine that already ran is not put back when the thread refresh fails", async ({
  page,
}) => {
  const composer = await openComposer(page, "send-failure-routine");
  await createRoutine(page, "daily-digest");
  await page.reload();
  await mentionRoutine(page, composer, "daily-digest");
  const chip = page.getByTestId("mention-chip");
  await expect(chip).toHaveText("daily-digest");

  const testRun = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/testRun") && response.ok(),
  );
  await page.route("**/rpc/threads/get", (route) => route.abort("internetdisconnected"));
  await composer.press("Enter");
  await testRun;

  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(chip).toHaveCount(0);
  await expect(composer).toHaveValue("");
});

test("a message is not put back when one of its routines already ran", async ({ page }) => {
  const composer = await openComposer(page, "send-failure-routines");
  await createRoutine(page, "daily-digest");
  const failing = await createRoutine(page, "weekly-review");
  await page.reload();
  await mentionRoutine(page, composer, "daily-digest");
  await mentionRoutine(page, composer, "weekly-review");
  await expect(page.getByTestId("mention-chip")).toHaveCount(2);

  await page.route("**/rpc/routines/testRun", (route) => {
    const input = route.request().postDataJSON() as { json: { routineId: string } };
    return input.json.routineId === failing.id
      ? route.abort("internetdisconnected")
      : route.continue();
  });
  const accepted = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/testRun") && response.ok(),
  );
  await composer.pressSequentially("and the notes");
  await composer.press("Enter");
  await accepted;

  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
  await expect(composer).toHaveValue("");
});

for (const target of ["bot", "group"] as const) {
  test(`an unchanged ${target} retry after a lost response creates only one message`, async ({
    page,
  }) => {
    const composer = await openComposer(page, `send-lost-${target}`);
    const botId = activeBotId(page);
    const threadTarget =
      target === "group"
        ? {
            groupId: (
              await rpc<{ id: string }>(page, "groups/create", {
                name: "Retry team",
                botIds: [botId, await createNamedBot(page, "Retry peer")],
              })
            ).id,
          }
        : { botId };
    if ("groupId" in threadTarget) {
      await page.goto(`/app/g/${threadTarget.groupId}`);
      await expect(composer).toBeVisible();
    }
    const nonces: string[] = [];
    const receipts: unknown[] = [];
    await page.route("**/rpc/threads/send", async (route) => {
      nonces.push(route.request().postDataJSON().json.clientNonce);
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      receipts.push((await response.json()).json);
      if (nonces.length === 1) await route.abort("internetdisconnected");
      else await route.fulfill({ response });
    });
    await composer.fill("retry after a lost response");
    await composer.press("Enter");
    await expect(page.getByTestId("composer-error")).toBeVisible();
    await expect(composer).toHaveValue("retry after a lost response");
    const retryResponse = page.waitForResponse(
      (response) => response.url().includes("/rpc/threads/send") && response.ok(),
    );
    await composer.press("Enter");
    await retryResponse;
    await expect(page.getByTestId("composer-error")).toBeHidden();
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).toBe(nonces[0]);
    expect(receipts[1]).toEqual(receipts[0]);
    const snapshot = await rpc<{ messages: ThreadMessage[] }>(page, "threads/get", threadTarget);
    expect(
      snapshot.messages.filter(
        (message) =>
          message.role === "user" &&
          message.blocks.some(
            (block) => block.kind === "text" && block.text === "retry after a lost response",
          ),
      ),
    ).toHaveLength(1);
  });
}

test("an unchanged routine retry after a lost response reuses the run", async ({ page }) => {
  const composer = await openComposer(page, "send-lost-routine");
  await createRoutine(page, "daily-digest");
  await page.reload();
  await mentionRoutine(page, composer, "daily-digest");
  const nonces: string[] = [];
  const runIds: string[] = [];
  await page.route("**/rpc/routines/testRun", async (route) => {
    nonces.push(route.request().postDataJSON().json.clientNonce);
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    runIds.push((await response.json()).json.runId);
    if (nonces.length === 1) await route.abort("internetdisconnected");
    else await route.fulfill({ response });
  });
  await composer.press("Enter");
  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(page.getByTestId("mention-chip")).toHaveText("daily-digest");
  const retryResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/testRun") && response.ok(),
  );
  await composer.press("Enter");
  await retryResponse;
  await expect(page.getByTestId("composer-error")).toBeHidden();
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
  expect(nonces).toHaveLength(2);
  expect(nonces[1]).toBe(nonces[0]);
  expect(runIds[1]).toBe(runIds[0]);
});

test("an accepted send clears recovered text after returning to the thread", async ({ page }) => {
  await openComposer(page, "pending-return");
  await createNamedBot(page, "Other thread");
  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("button", { name: /^Chief/ }).click();
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  let releaseSend = () => {};
  const released = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  await page.route("**/rpc/threads/send", async (route) => {
    await released;
    await route.continue();
  });
  await composer.fill("pending accepted message");
  const request = page.waitForRequest("**/rpc/threads/send");
  await composer.press("Enter");
  await request;
  await expect(composer).toHaveValue("");
  await sidebar.getByRole("button", { name: /^Other thread/ }).click();
  await sidebar.getByRole("button", { name: /^Chief/ }).click();
  await expect(composer).toHaveValue("pending accepted message");
  releaseSend();
  await expect(composer).toHaveValue("");
  await page.reload();
  await expect(composer).toHaveValue("");
});

test("an unsupported-image rejection keeps the draft for a compatible resend", async ({
  page,
}, testInfo) => {
  const composer = await openComposer(page, "image-model-rejection");
  const botId = activeBotId(page);
  await rpc(page, "models/connect", {
    provider: "openai-compatible",
    modelId: "fixture-text-model",
    baseUrl: "http://127.0.0.1:8090/v1",
    supportsImages: false,
  });
  await rpc(page, "bots/update", {
    botId,
    modelProvider: "openai-compatible",
    modelId: "fixture-text-model",
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "picture.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const remove = page.getByRole("button", { name: "Remove picture.png" });
  await expect(remove).toBeVisible();
  let rejectedBody: unknown;
  let uploads = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/artifacts/create")) uploads++;
  });
  const rejection = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/send") && response.status() === 409,
  );
  page.on("request", (request) => {
    if (request.url().includes("/rpc/threads/send") && !rejectedBody)
      rejectedBody = request.postDataJSON();
  });
  await composer.fill("Read this picture");
  await composer.press("Enter");
  await rejection;
  expect((rejectedBody as { json: { imageHandling?: string } }).json.imageHandling).toBe("confirm");
  await expect(page.getByTestId("composer-error")).toHaveText(
    /Image input is not configured for this model/,
  );
  await expect(composer).toHaveValue("Read this picture");
  await expect(remove).toBeVisible();
  const sendAsFile = page.getByRole("button", { name: "Send as file", exact: true });
  const changeModel = page.getByRole("button", { name: "Change model", exact: true });
  await expect(sendAsFile).toBeVisible();
  await expect(changeModel).toBeVisible();
  const fileNote = "The bot can use the file but won't see the picture.";
  await expect(
    page.getByTestId("composer-error").getByText(fileNote, { exact: true }),
  ).toBeVisible();
  await expect(sendAsFile).toHaveAccessibleDescription(fileNote);
  await captureScreenshot(page, testInfo, "image-model-rejection-keeps-draft");
  // In a bot thread the bot's own model is the one this send used.
  await changeModel.click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByRole("combobox", { name: "Model", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(composer).toHaveValue("Read this picture");
  const resent = page.waitForRequest("**/rpc/threads/send");
  await sendAsFile.click();
  const body = (await resent).postDataJSON();
  expect(body.json).toEqual({ ...(rejectedBody as { json: object }).json, imageHandling: "file" });
  expect(uploads).toBe(1);
  await expect(
    page.getByTestId("transcript").getByText("Read this picture", { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(remove).toBeHidden();
  await captureScreenshot(page, testInfo, "image-sent-as-file");
});

for (const change of ["text", "attachment"] as const) {
  test(`a late image rejection offers no file resend after a ${change} edit`, async ({ page }) => {
    const composer = await openComposer(page, `late-image-rejection-${change}`);
    const botId = activeBotId(page);
    await rpc(page, "models/connect", {
      provider: "openai-compatible",
      modelId: "fixture-text-model",
      baseUrl: "http://127.0.0.1:8090/v1",
      supportsImages: false,
    });
    await rpc(page, "bots/update", {
      botId,
      modelProvider: "openai-compatible",
      modelId: "fixture-text-model",
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "picture.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await expect(page.getByRole("button", { name: "Remove picture.png" })).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let intercepted!: () => void;
    const reached = new Promise<void>((resolve) => (intercepted = resolve));
    await page.route("**/rpc/threads/send", async (route) => {
      intercepted();
      await held;
      await route.continue();
    });
    const rejection = page.waitForResponse(
      (response) => response.url().includes("/rpc/threads/send") && response.status() === 409,
    );
    await composer.fill("Read this picture");
    await composer.press("Enter");
    await reached;
    // The newer draft is not the submission the server is about to reject.
    if (change === "text") await composer.fill("A newer draft");
    else
      await page.locator('input[type="file"]').setInputFiles({
        name: "extra.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("extra"),
      });
    release();
    await rejection;
    await expect(page.getByTestId("composer-error")).toHaveText(
      /Image input is not configured for this model/,
    );
    await expect(page.getByRole("button", { name: "Send as file", exact: true })).toHaveCount(0);
    if (change === "text") await expect(composer).toHaveValue("A newer draft");
    else await expect(page.getByRole("button", { name: "Remove extra.txt" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove picture.png" })).toBeVisible();
  });
}

test("separate picks with matching file metadata upload their own bytes", async ({ page }) => {
  const composer = await openComposer(page, "attachment-identity");
  const uploads: string[] = [];
  await page.route("**/rpc/artifacts/create", async (route) => {
    uploads.push(route.request().postDataJSON().json.contentBase64);
    await route.continue();
  });
  const metadata: Array<{ name: string; size: number; lastModified: number }> = [];
  for (const content of ["first", "other"]) {
    metadata.push(
      await page.locator('input[type="file"]').evaluate((element, text) => {
        const input = element as HTMLInputElement;
        const file = new File([text], "same.txt", {
          type: "text/plain",
          lastModified: 1234567890000,
        });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return { name: file.name, size: file.size, lastModified: file.lastModified };
      }, content),
    );
  }
  expect(metadata[0]).toEqual(metadata[1]);
  await composer.fill("Process both files");
  await composer.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("Process both files", { exact: true }),
  ).toBeVisible();
  expect(uploads).toEqual([
    Buffer.from("first").toString("base64"),
    Buffer.from("other").toString("base64"),
  ]);
});
