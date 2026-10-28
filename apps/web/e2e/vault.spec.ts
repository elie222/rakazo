import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

// Fake values only: this spec proves the UI and API echo a saved credential only when the
// person asks to see it and confirms it's them.
const SENTINEL = "fake-bot-credential-values-never-leak";
const REPLACEMENT = "fake-bot-credential-value-two";
const CREDENTIAL_NAME = "example_api";
// The bot's shell is what actually reads a command variable; see the unit tests.
const COMMAND_SENTINEL = "fake-command-variable-values-never-leak";
const COMMAND_REPLACEMENT = "fake-command-variable-value-two";
const COMMAND_CREDENTIAL_NAME = "netbird-setup-key";
const COMMAND_VARIABLE_NAME = "$NETBIRD_SETUP_KEY";
const LOGIN_ID = "fake-login-id-never-leaks";
const LOGIN_PHONE = "fake-login-phone-never-leaks";
const account = { scope: "account" };

test("vault and command credentials add, replace and remove without leaking values", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `vault-${stamp}@rakazo.test`, "password12", "Vault");
  await completeOnboarding(page);

  const settings = await openUserSettings(page, "vault");
  await expect(settings).toHaveAttribute("data-settings-section", "vault");
  await expect(settings.getByRole("heading", { name: "Vault", exact: true })).toBeVisible();
  const credentials = settings.getByTestId("vault");
  await expect(credentials).toBeVisible();
  await expect(
    credentials.getByRole("button", { name: "Add credential", exact: true }),
  ).toBeVisible();
  const card = credentials.getByTestId("vault-card");
  await expect(card).toHaveCount(0);
  await captureScreenshot(page, testInfo, "vault-empty");

  // Add: a password field holds the value, which is cleared once the save starts.
  await credentials.getByTestId("credential-add").click();
  const addForm = credentials.getByTestId("credential-add-form");
  await addForm.getByTestId("credential-name").fill(CREDENTIAL_NAME);
  await addForm.getByTestId("credential-origin").fill("https://api.example.test");
  const valueInput = addForm.getByTestId("credential-value");
  await expect(valueInput).toHaveAttribute("type", "password");
  await expect(valueInput).toHaveAttribute("autocomplete", "new-password");
  await valueInput.fill(SENTINEL);
  await captureScreenshot(page, testInfo, "vault-add");
  await addForm.getByTestId("credential-add-save").click();

  const row = credentials.getByTestId("vault-credential-row");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveCSS("border-top-width", "0px");
  await expect(row).toHaveCSS("padding-left", "0px");
  expect((await row.boundingBox())!.x).toBe((await card.boundingBox())!.x + 16);
  await expect(row).toContainText(CREDENTIAL_NAME);
  await expect(row).toContainText("https://api.example.test");
  await expect(row).toContainText("Bearer token");
  await expect(addForm).toHaveCount(0);

  // The API returns metadata only, and no input still holds the value.
  const listed = await rpc<Array<Record<string, unknown>>>(page, "vault/list", account);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    name: CREDENTIAL_NAME,
    origin: "https://api.example.test",
    auth: { type: "bearer" },
  });
  expect(JSON.stringify(listed)).not.toContain(SENTINEL);
  expect(JSON.stringify(listed)).not.toContain("ciphertext");
  await expectNoLeakedInputValue(page, SENTINEL);

  // Show: the value appears only after the person confirms it's them, and hides on request.
  await credentials.getByTestId(`credential-show-${CREDENTIAL_NAME}`).click();
  const identity = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(identity).toBeVisible();
  await captureScreenshot(page, testInfo, "vault-show-confirm-identity");
  await identity.getByRole("textbox", { name: "Password" }).fill("password12");
  await identity.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(identity).toBeHidden();
  await expect(credentials.getByTestId("credential-revealed-value")).toHaveText(SENTINEL);
  await captureScreenshot(page, testInfo, "vault-shown-value");
  await credentials.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(credentials.getByTestId("credential-revealed")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(SENTINEL);

  // Replace: keeps the destination, writes a new value, leaves the old one gone.
  const replaced = page.waitForResponse(
    (response) => response.url().includes("/rpc/vault/put") && response.ok(),
  );
  await credentials.getByTestId(`credential-replace-${CREDENTIAL_NAME}`).click();
  await credentials.getByTestId("credential-replace-value").fill(REPLACEMENT);
  await credentials.getByTestId("credential-replace-save").click();
  await replaced;
  await expect(row).toHaveCount(1);
  await expect(credentials.getByTestId("credential-replace-value")).toHaveCount(0);
  await expectNoLeakedInputValue(page, SENTINEL);
  await expectNoLeakedInputValue(page, REPLACEMENT);
  await captureScreenshot(page, testInfo, "vault-replace");

  // Remove: needs an explicit confirm, then the empty state returns.
  await credentials.getByTestId(`credential-remove-${CREDENTIAL_NAME}`).click();
  await expect(credentials).toContainText(`Remove ${CREDENTIAL_NAME}?`);
  const removed = page.waitForResponse(
    (response) => response.url().includes("/rpc/vault/remove") && response.ok(),
  );
  await credentials.getByTestId(`credential-remove-confirm-${CREDENTIAL_NAME}`).click();
  await removed;
  await expect(row).toHaveCount(0);
  await expect(credentials.getByTestId("credential-add")).toBeVisible();
  expect(await rpc<unknown[]>(page, "vault/list", account)).toHaveLength(0);
  await captureScreenshot(page, testInfo, "vault-removed");

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
  await expect(row).toContainText(
    new RegExp(`Command variable\\s*${COMMAND_VARIABLE_NAME.replace("$", "\\$")}`),
  );
  await expect(commandForm).toHaveCount(0);

  // The API returns metadata only: the type, an empty origin, and no value.
  const commandListed = await rpc<Array<Record<string, unknown>>>(page, "vault/list", account);
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
    (response) => response.url().includes("/rpc/vault/put") && response.ok(),
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
    (response) => response.url().includes("/rpc/vault/remove") && response.ok(),
  );
  await credentials.getByTestId(`credential-remove-confirm-${COMMAND_CREDENTIAL_NAME}`).click();
  await commandRemoved;
  await expect(row).toHaveCount(0);
  await expect(credentials.getByTestId("credential-add")).toBeVisible();
  expect(await rpc<unknown[]>(page, "vault/list", account)).toHaveLength(0);
  await captureScreenshot(page, testInfo, "command-credentials-removed");

  // Website login: named fields, each hidden or visible as the person chooses.
  await credentials.getByTestId("credential-add").click();
  const loginForm = credentials.getByTestId("credential-add-form");
  await loginForm.getByTestId("credential-name").fill("example_login");
  await loginForm.getByTestId("credential-origin").fill("https://login.example.test");
  await loginForm.getByTestId("credential-auth-type").selectOption("login");
  const fields = loginForm.getByTestId("login-field");
  await expect(fields).toHaveCount(2);
  const label = (index: number) => fields.nth(index).locator('input[aria-label="Label"]');
  await label(0).fill("ID number");
  await fields.nth(0).locator('input[aria-label="ID number"]').fill(LOGIN_ID);
  await label(1).fill("Phone number");
  const phone = fields.nth(1).locator('input[aria-label="Phone number"]');
  await expect(phone).toHaveAttribute("type", "password");
  await phone.fill(LOGIN_PHONE);
  await loginForm.getByRole("button", { name: "Add field", exact: true }).click();
  await expect(fields).toHaveCount(3);
  await label(2).fill("PIN");
  await fields.nth(2).locator('input[aria-label="PIN"]').fill("fake-pin");
  await captureScreenshot(page, testInfo, "vault-login-fields");
  await loginForm.getByTestId("credential-add-save").click();

  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Website login");
  const loginListed = await rpc<Array<Record<string, unknown>>>(page, "vault/list", account);
  expect(loginListed[0]).toMatchObject({ name: "example_login", auth: { type: "login" } });
  for (const secret of [LOGIN_ID, LOGIN_PHONE]) {
    expect(JSON.stringify(loginListed)).not.toContain(secret);
    await expectNoLeakedInputValue(page, secret);
  }
});

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
