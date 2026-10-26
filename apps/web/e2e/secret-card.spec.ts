import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("renders masked secret card and saves without putting the value in chat", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `secret-card-${stamp}@rakazo.test`, "password12", "Secret Card");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("show a secret card for a masked api key");
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");

  // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
  const card = page.getByTestId("secret-ask-card");
  if ((await card.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("API key", { exact: true }).first()).toBeVisible();
  await expect(card.getByText("https://api.example.test", { exact: true })).toBeVisible();
  const secretField = card.getByLabel("API key");
  await expect(secretField).toHaveAttribute("type", "password");
  await expect(card.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "secret-card");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  await expect(secretField).toBeVisible();
  await captureScreenshot(page, testInfo, "secret-card-narrow");

  await page.setViewportSize({ width: 1280, height: 720 });
  const secretValue = `sk-test-secret-${stamp}`;
  // Clear sensitive client state before waiting for a network result, including failures.
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  await page.route("**/rpc/threads/answer", async (route) => {
    await failureGate;
    await route.fulfill({
      status: 400,
      json: { json: { defined: false, code: "BAD_REQUEST", status: 400, message: secretValue } },
    });
  });
  await secretField.fill(secretValue);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(secretField).toHaveValue("");
    await expect(secretField).toBeDisabled();
    await expect(card.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
  } finally {
    releaseFailure();
  }
  await expect(card.getByText("Could not submit this answer", { exact: true })).toBeVisible();
  await expect(page.getByText(secretValue)).toHaveCount(0);
  await expect(secretField).toHaveValue("");
  await page.unroute("**/rpc/threads/answer");

  await secretField.fill(secretValue);
  await card.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(secretValue)).toHaveCount(0);
  await expect(composer).not.toHaveValue(secretValue);

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{
            blocks: Array<{
              kind: string;
              status?: string;
              answer?: string;
              input?: string;
              text?: string;
              detail?: string;
            }>;
          }>;
        }>(page, "threads/messages", { botId });
        const answered = history.messages
          .flatMap((message) => message.blocks)
          .find(
            (block) =>
              block.kind === "ask" && block.input === "secret" && block.status === "answered",
          );
        if (!answered) return null;
        const serialized = JSON.stringify(history);
        if (serialized.includes(secretValue)) return "leaked";
        return answered.answer ?? "";
      },
      { timeout: 30_000 },
    )
    .toBe("");

  // Check again after the worker resumes, then reload to verify the durable Saved state.
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? "completed";
      },
      { timeout: 30_000 },
    )
    .toBe("completed");
  const history = await rpc(page, "threads/messages", { botId });
  expect(JSON.stringify(history)).not.toContain(secretValue);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(card.getByText("Saved", { exact: true })).toBeVisible();
  await expect(card.locator("input")).toHaveCount(0);
  await expect(page.getByText(secretValue)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "secret-card-saved");
});

test("keeps the line breaks of a pasted multi-line secret", async ({ page, context }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `secret-multiline-${stamp}@rakazo.test`, "password12", "Secret Multiline");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  await page.getByPlaceholder(/Message/).fill("show a secret card for a masked api key");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");
  const card = page.getByTestId("secret-ask-card");
  if ((await card.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(card).toBeVisible({ timeout: 15_000 });

  const answers: string[] = [];
  await page.route("**/rpc/threads/answer", async (route) => {
    answers.push(route.request().postDataJSON().json.answer);
    await route.fulfill({
      status: 400,
      json: { json: { defined: false, code: "BAD_REQUEST", status: 400, message: "rejected" } },
    });
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const secretField = card.getByLabel("API key");
  const save = card.getByRole("button", { name: "Save", exact: true });

  // A single-line value copied with a trailing line break stays in the password field.
  await page.evaluate(() => navigator.clipboard.writeText("sk-single-line\n"));
  await secretField.click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(secretField).toHaveAttribute("type", "password");
  await save.click();
  await expect(card.getByText("Could not submit this answer", { exact: true })).toBeVisible();

  const key = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA${stamp}\nQyNTUxOQAAACBmYWtl\n-----END OPENSSH PRIVATE KEY-----\n`;
  await page.evaluate((value) => navigator.clipboard.writeText(value), key);
  await secretField.click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(secretField).toHaveValue(key);
  await expect(secretField).toHaveCSS("-webkit-text-security", "disc");
  await expect(secretField).toBeFocused();
  expect(await secretField.evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(
    key.length,
  );
  // Clearing the pasted key keeps the text area, so a corrected key can be pasted straight in.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await expect(secretField).toBeFocused();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(secretField).toHaveValue(key);
  await captureScreenshot(page, testInfo, "secret-card-multiline");
  await save.click();
  await expect(secretField).toHaveValue("");
  await expect(secretField).toHaveAttribute("type", "password");

  await expect.poll(() => answers).toEqual(["sk-single-line", key]);
});

test("dismisses a secret card, resumes the bot and frees the composer", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `secret-dismiss-${stamp}@rakazo.test`, "password12", "Secret Dismiss");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("show a secret card for a masked api key");
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");

  const card = page.getByTestId("secret-ask-card");
  if ((await card.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(card).toBeVisible({ timeout: 15_000 });
  const typedValue = `sk-test-dismissed-${stamp}`;
  await card.getByLabel("API key").fill(typedValue);
  await card.getByRole("button", { name: "Dismiss", exact: true }).click();

  await expect(card.getByText("Dismissed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(card.locator("input")).toHaveCount(0);
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? "completed";
      },
      { timeout: 30_000 },
    )
    .toBe("completed");
  const history = await rpc(page, "threads/messages", { botId });
  expect(JSON.stringify(history)).not.toContain(typedValue);
  await captureScreenshot(page, testInfo, "secret-card-dismissed");

  // The composer is no longer held by the pending card.
  await composer.fill(`after dismissing ${stamp}`);
  await page.keyboard.press("Enter");
  await expect(page.getByText(`after dismissing ${stamp}`, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(card.getByText("Dismissed", { exact: true })).toBeVisible();
});
