import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

// Fake values only: this spec proves the Credentials UI drives a command variable and never
// echoes a saved value. The bot's shell is what actually reads the variable; see the unit tests.
const SENTINEL = "fake-command-variable-values-never-leak";
const REPLACEMENT = "fake-command-variable-value-two";
const CREDENTIAL_NAME = "netbird-setup-key";
const VARIABLE_NAME = "$NETBIRD_SETUP_KEY";

test("command credentials add, replace and remove without leaking values", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `command-credentials-${stamp}@rakazo.test`, "password12", "Command Creds");
  await completeOnboarding(page);
  const botName = `Command ${stamp}`;
  const botId = await createNamedBot(page, botName);

  await page.locator("main").getByRole("button", { name: botName, exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("bot-settings-advanced").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  const credentials = settings.getByTestId("bot-credentials");
  await expect(credentials).toBeVisible();
  await expect(credentials.getByTestId("bot-credentials-empty")).toBeVisible();

  // Add: choosing the command type removes the site field and shows the derived variable.
  await credentials.getByTestId("credential-add").click();
  const addForm = credentials.getByTestId("credential-add-form");
  await addForm.getByTestId("credential-name").fill(CREDENTIAL_NAME);
  await addForm.getByTestId("credential-auth-type").selectOption("command");
  await expect(addForm.getByTestId("credential-origin")).toHaveCount(0);
  await expect(addForm.getByTestId("credential-command-variable")).toContainText(VARIABLE_NAME);
  const valueInput = addForm.getByTestId("credential-value");
  await expect(valueInput).toHaveAttribute("type", "password");
  await expect(valueInput).toHaveAttribute("autocomplete", "new-password");
  await valueInput.fill(SENTINEL);
  await captureScreenshot(page, testInfo, "command-credentials-add");
  await addForm.getByTestId("credential-add-save").click();

  const row = credentials.getByTestId("bot-credential-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(CREDENTIAL_NAME);
  await expect(row).toContainText(`Command variable · ${VARIABLE_NAME}`);
  await expect(addForm).toHaveCount(0);

  // The API returns metadata only: the type, an empty origin, and no value.
  const listed = await rpc<Array<Record<string, unknown>>>(page, "botSecrets/list", { botId });
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    name: CREDENTIAL_NAME,
    origin: "",
    auth: { type: "command" },
  });
  expect(JSON.stringify(listed)).not.toContain(SENTINEL);
  expect(JSON.stringify(listed)).not.toContain("ciphertext");
  await expectNoLeakedInputValue(page, SENTINEL);

  // Replace: writes a new value on the same destination and leaves the old one gone.
  const replaced = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSecrets/put") && response.ok(),
  );
  await credentials.getByTestId(`credential-replace-${CREDENTIAL_NAME}`).click();
  await credentials.getByTestId("credential-replace-value").fill(REPLACEMENT);
  await credentials.getByTestId("credential-replace-save").click();
  await replaced;
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(VARIABLE_NAME);
  await expect(credentials.getByTestId("credential-replace-value")).toHaveCount(0);
  await expectNoLeakedInputValue(page, SENTINEL);
  await expectNoLeakedInputValue(page, REPLACEMENT);
  await captureScreenshot(page, testInfo, "command-credentials-replace");

  // Remove: needs an explicit confirm, then the empty state returns.
  await credentials.getByTestId(`credential-remove-${CREDENTIAL_NAME}`).click();
  await expect(credentials).toContainText(`Remove ${CREDENTIAL_NAME}?`);
  const removed = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSecrets/remove") && response.ok(),
  );
  await credentials.getByTestId(`credential-remove-confirm-${CREDENTIAL_NAME}`).click();
  await removed;
  await expect(row).toHaveCount(0);
  await expect(credentials.getByTestId("bot-credentials-empty")).toBeVisible();
  expect(await rpc<unknown[]>(page, "botSecrets/list", { botId })).toHaveLength(0);
  await captureScreenshot(page, testInfo, "command-credentials-removed");
});

test("command credentials refuse a reserved variable name before saving", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `command-reserved-${stamp}@rakazo.test`, "password12", "Reserved Name");
  await completeOnboarding(page);
  const botName = `Reserved ${stamp}`;
  await createNamedBot(page, botName);

  await page.locator("main").getByRole("button", { name: botName, exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("bot-settings-advanced").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  const credentials = settings.getByTestId("bot-credentials");
  await credentials.getByTestId("credential-add").click();
  const addForm = credentials.getByTestId("credential-add-form");
  await addForm.getByTestId("credential-auth-type").selectOption("command");
  await addForm.getByTestId("credential-value").fill(SENTINEL);
  await addForm.getByTestId("credential-name").fill("ld_preload");

  await expect(addForm.getByTestId("credential-command-variable-error")).toContainText(
    "$LD_PRELOAD is reserved",
  );
  await expect(addForm.getByTestId("credential-command-variable")).toHaveCount(0);
  await expect(addForm.getByTestId("credential-add-save")).toBeDisabled();
  await captureScreenshot(page, testInfo, "command-credentials-reserved-name");
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
