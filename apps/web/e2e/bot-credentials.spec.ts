import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

// Fake values only: this spec proves the UI and API never echo a saved credential.
const SENTINEL = "fake-bot-credential-values-never-leak";
const REPLACEMENT = "fake-bot-credential-value-two";
const CREDENTIAL_NAME = "example_api";
// The bot's shell is what actually reads a command variable; see the unit tests.
const COMMAND_SENTINEL = "fake-command-variable-values-never-leak";
const COMMAND_REPLACEMENT = "fake-command-variable-value-two";
const COMMAND_CREDENTIAL_NAME = "netbird-setup-key";
const COMMAND_VARIABLE_NAME = "$NETBIRD_SETUP_KEY";

test("bot and command credentials add, replace and remove without leaking values", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-credentials-${stamp}@rakazo.test`, "password12", "Bot Credentials");
  await completeOnboarding(page);
  const botName = `Credentials ${stamp}`;
  const botId = await createNamedBot(page, botName);

  await page.locator("main").getByRole("button", { name: botName, exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  const credentials = settings.getByTestId("bot-credentials");
  await expect(credentials).toBeVisible();
  await expect(credentials.getByTestId("credential-add")).toBeVisible();

  const add = credentials.getByRole("button", { name: "Add credential", exact: true });
  await expect(add).toHaveText("");
  await expect(
    credentials.getByRole("heading", { name: "Credentials", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByTestId("bot-settings-tools").getByTestId("bot-credentials"),
  ).toHaveCount(0);
  const card = credentials.getByTestId("bot-credentials-card");
  await expect(card.getByText("Encrypted and never shown again", { exact: true })).toBeVisible();
  await expect(card.getByTestId("credential-add-form")).toHaveCount(0);
  await add.hover();
  await expect(
    page.locator('[data-slot="tooltip-content"]').filter({ hasText: "Add credential" }),
  ).toBeVisible();

  // Add: a password field holds the value, which is cleared once the save starts.
  await credentials.getByTestId("credential-add").click();
  const addForm = credentials.getByTestId("credential-add-form");
  await addForm.getByTestId("credential-name").fill(CREDENTIAL_NAME);
  await addForm.getByTestId("credential-origin").fill("https://api.example.test");
  const valueInput = addForm.getByTestId("credential-value");
  await expect(valueInput).toHaveAttribute("type", "password");
  await expect(valueInput).toHaveAttribute("autocomplete", "new-password");
  await valueInput.fill(SENTINEL);
  await captureScreenshot(page, testInfo, "bot-credentials-add");
  await addForm.getByTestId("credential-add-save").click();

  const row = credentials.getByTestId("bot-credential-row");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveCSS("border-top-width", "0px");
  await expect(row).toHaveCSS("padding-left", "0px");
  expect((await row.boundingBox())!.x).toBe((await card.boundingBox())!.x + 16);
  await expect(row).toContainText(CREDENTIAL_NAME);
  await expect(row).toContainText("https://api.example.test");
  await expect(row).toContainText("Bearer token");
  await expect(addForm).toHaveCount(0);

  // The API returns metadata only, and no input still holds the value.
  const listed = await rpc<Array<Record<string, unknown>>>(page, "botSecrets/list", { botId });
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    name: CREDENTIAL_NAME,
    origin: "https://api.example.test",
    auth: { type: "bearer" },
  });
  expect(JSON.stringify(listed)).not.toContain(SENTINEL);
  expect(JSON.stringify(listed)).not.toContain("ciphertext");
  await expectNoLeakedInputValue(page, SENTINEL);

  // Replace: keeps the destination, writes a new value, leaves the old one gone.
  const replaced = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSecrets/put") && response.ok(),
  );
  await credentials.getByTestId(`credential-replace-${CREDENTIAL_NAME}`).click();
  await credentials.getByTestId("credential-replace-value").fill(REPLACEMENT);
  await credentials.getByTestId("credential-replace-save").click();
  await replaced;
  await expect(row).toHaveCount(1);
  await expect(credentials.getByTestId("credential-replace-value")).toHaveCount(0);
  await expectNoLeakedInputValue(page, SENTINEL);
  await expectNoLeakedInputValue(page, REPLACEMENT);
  await captureScreenshot(page, testInfo, "bot-credentials-replace");

  // Remove: needs an explicit confirm, then the empty state returns.
  await credentials.getByTestId(`credential-remove-${CREDENTIAL_NAME}`).click();
  await expect(credentials).toContainText(`Remove ${CREDENTIAL_NAME}?`);
  const removed = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSecrets/remove") && response.ok(),
  );
  await credentials.getByTestId(`credential-remove-confirm-${CREDENTIAL_NAME}`).click();
  await removed;
  await expect(row).toHaveCount(0);
  await expect(credentials.getByTestId("credential-add")).toBeVisible();
  expect(await rpc<unknown[]>(page, "botSecrets/list", { botId })).toHaveLength(0);
  await captureScreenshot(page, testInfo, "bot-credentials-removed");

  // Command add: choosing the command type removes the site field and shows the derived variable.
  await credentials.getByTestId("credential-add").click();
  const commandForm = credentials.getByTestId("credential-add-form");
  await commandForm.getByTestId("credential-name").fill(COMMAND_CREDENTIAL_NAME);
  await commandForm.getByTestId("credential-auth-type").selectOption("command");
  await expect(commandForm.getByTestId("credential-origin")).toHaveCount(0);
  await expect(commandForm.getByTestId("credential-command-variable")).toContainText(
    COMMAND_VARIABLE_NAME,
  );
  const commandValueInput = commandForm.getByTestId("credential-value");
  await expect(commandValueInput).toHaveAttribute("type", "password");
  await expect(commandValueInput).toHaveAttribute("autocomplete", "new-password");
  await commandValueInput.fill(COMMAND_SENTINEL);
  await captureScreenshot(page, testInfo, "command-credentials-add");
  await commandForm.getByTestId("credential-add-save").click();

  await expect(row).toHaveCount(1);
  await expect(row).toContainText(COMMAND_CREDENTIAL_NAME);
  await expect(row).toContainText(`Command variable · ${COMMAND_VARIABLE_NAME}`);
  await expect(commandForm).toHaveCount(0);

  // The API returns metadata only: the type, an empty origin, and no value.
  const commandListed = await rpc<Array<Record<string, unknown>>>(page, "botSecrets/list", {
    botId,
  });
  expect(commandListed).toHaveLength(1);
  expect(commandListed[0]).toMatchObject({
    name: COMMAND_CREDENTIAL_NAME,
    origin: "",
    auth: { type: "command" },
  });
  expect(JSON.stringify(commandListed)).not.toContain(COMMAND_SENTINEL);
  expect(JSON.stringify(commandListed)).not.toContain("ciphertext");
  await expectNoLeakedInputValue(page, COMMAND_SENTINEL);

  // Command replace: writes a new value on the same destination and leaves the old one gone.
  const commandReplaced = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSecrets/put") && response.ok(),
  );
  await credentials.getByTestId(`credential-replace-${COMMAND_CREDENTIAL_NAME}`).click();
  await credentials.getByTestId("credential-replace-value").fill(COMMAND_REPLACEMENT);
  await credentials.getByTestId("credential-replace-save").click();
  await commandReplaced;
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(COMMAND_VARIABLE_NAME);
  await expect(credentials.getByTestId("credential-replace-value")).toHaveCount(0);
  await expectNoLeakedInputValue(page, COMMAND_SENTINEL);
  await expectNoLeakedInputValue(page, COMMAND_REPLACEMENT);
  await captureScreenshot(page, testInfo, "command-credentials-replace");

  // Command remove: needs an explicit confirm, then the empty state returns.
  await credentials.getByTestId(`credential-remove-${COMMAND_CREDENTIAL_NAME}`).click();
  await expect(credentials).toContainText(`Remove ${COMMAND_CREDENTIAL_NAME}?`);
  const commandRemoved = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSecrets/remove") && response.ok(),
  );
  await credentials.getByTestId(`credential-remove-confirm-${COMMAND_CREDENTIAL_NAME}`).click();
  await commandRemoved;
  await expect(row).toHaveCount(0);
  await expect(credentials.getByTestId("credential-add")).toBeVisible();
  expect(await rpc<unknown[]>(page, "botSecrets/list", { botId })).toHaveLength(0);
  await captureScreenshot(page, testInfo, "command-credentials-removed");
});

/** Fail if any live input value still carries a protected value. */
async function expectNoLeakedInputValue(page: Page, value: string) {
  const leaked = await page.evaluate((needle) => {
    const inputs = Array.from(document.querySelectorAll("input, textarea"));
    return inputs.some((input) => {
      const field = input as HTMLInputElement | HTMLTextAreaElement;
      return field.value.includes(needle);
    });
  }, value);
  expect(leaked).toBe(false);
}
