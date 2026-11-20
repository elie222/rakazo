import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Me } from "@rakazo/contracts";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "./helpers/helpers";

async function completeAccountOnboarding(page: Page, automatic = true) {
  await completeOnboarding(page);
  if (automatic) await expect(page.getByTestId("user-settings")).toBeVisible();
}

// This suite exercises the account settings entry point with the offline model runtime.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/model-account/config", (route) =>
    route.fulfill({
      json: { enabled: false, modelAccountOnly: true },
    }),
  );
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("model account settings show balance and platform actions", async ({ page }, testInfo) => {
  let connected = false;
  let apiProtocol = "chat-completions";
  let modelRefreshes = 0;
  let amount = "12.34";
  let revocationUnknown = false;
  let revokeAttempts = 0;
  await page.route("**/api/model-account/config", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        modelAccountOnly: true,
        navigation: {
          cookieName: "one_nav",
          defaults: {
            homeUrl: "https://home.example.test/",
            rechargeUrl: "https://wallet.example.test/",
          },
          channels: [],
          productHosts: [],
        },
        modelId: "example-model",
      },
    }),
  );
  await page.route("**/api/model-account/status", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        modelAccountOnly: true,
        connected,
        credentialId: connected ? "external-fixture" : undefined,
        apiProtocol,
        linked: true,
        ...(revocationUnknown ? { recovery: "revocation_unknown" } : {}),
      },
    }),
  );
  await page.route("**/api/model-account/balance", (route) =>
    route.fulfill({ json: { amount, unit: "USD" } }),
  );
  await page.route("**/api/model-account/connect", (route) => {
    connected = true;
    return route.fulfill({ json: { connected } });
  });
  await page.route("**/api/model-account/settings", (route) => {
    apiProtocol = route.request().postDataJSON().apiProtocol;
    return route.fulfill({ json: { apiProtocol } });
  });
  await page.route("**/api/model-account/models", (route) => {
    modelRefreshes++;
    return route.fulfill({ json: { connected: true } });
  });
  await page.route("**/api/model-account/revoke", (route) => {
    connected = false;
    revokeAttempts++;
    if (revokeAttempts === 1) {
      revocationUnknown = true;
      return route.fulfill({ status: 503, json: { error: "result_unknown" } });
    }
    revocationUnknown = false;
    return route.fulfill({ json: { connected } });
  });
  await signup(page, `model-account-${Date.now()}@rakazo.test`, "password12", "Fixture User");
  await completeAccountOnboarding(page);
  const settings = await openUserSettings(page, "models");
  await expect(
    settings.getByRole("heading", { name: "Authorize model service", exact: true }),
  ).toBeVisible();
  await expect(settings.getByText("12.34 USD", { exact: true })).toBeHidden();
  await expect(settings.getByRole("button", { name: "Refresh balance", exact: true })).toBeHidden();
  await expect(settings.getByRole("link", { name: "Recharge", exact: true })).toBeHidden();
  await settings.getByRole("button", { name: "Agree and authorize", exact: true }).click();
  await expect(settings).toBeHidden();
  await openUserSettings(page, "models");
  await expect(settings.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Disconnect", exact: true })).toBeHidden();
  await expect(settings.getByRole("link", { name: "Recharge", exact: true })).toHaveAttribute(
    "href",
    "https://wallet.example.test/",
  );
  await expect(
    settings.getByRole("button", { name: "Agree and authorize", exact: true }),
  ).toBeHidden();
  amount = "22.34";
  await settings.getByRole("button", { name: "Refresh balance", exact: true }).click();
  await expect(settings.getByText("22.34 USD", { exact: true })).toBeVisible();
  amount = "32.34";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(settings.getByText("32.34 USD", { exact: true })).toBeVisible();
  await settings.getByRole("combobox", { name: "API protocol", exact: true }).click();
  await page.getByRole("option", { name: "Responses", exact: true }).click();
  await expect(settings.getByRole("combobox", { name: "API protocol", exact: true })).toContainText(
    "Responses",
  );
  await settings.getByRole("button", { name: "Refresh models", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Refresh models", exact: true })).toBeEnabled();
  expect(modelRefreshes).toBe(1);
  await expect(settings.getByText("32.34 USD", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "model-account-settings");
  // A pending disconnection created by an older client remains recoverable.
  connected = false;
  revocationUnknown = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    settings.getByText("Disconnection pending confirmation.", { exact: true }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Retry disconnect", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "Retry disconnect", exact: true }),
  ).toBeEnabled();
  await settings.getByRole("button", { name: "Retry disconnect", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "Retry disconnect", exact: true }),
  ).toBeHidden();
});

for (const locale of ["en", "zh-CN"]) {
  test(`a failed account connection keeps an error on the original page (${locale})`, async ({
    page,
  }, testInfo) => {
    let connected = false;
    let available = false;
    await page.route("**/api/model-account/config", (route) =>
      route.fulfill({ json: { enabled: true, modelAccountOnly: true } }),
    );
    await page.route("**/api/model-account/status", (route) =>
      route.fulfill({ json: { enabled: true, modelAccountOnly: true, connected, linked: true } }),
    );
    await page.route("**/api/model-account/balance", (route) =>
      available
        ? route.fulfill({ json: { amount: "12.34", unit: "USD" } })
        : route.fulfill({ status: 503, json: { error: "unavailable" } }),
    );
    await page.route("**/api/model-account/connect", (route) => {
      if (!available) return route.fulfill({ status: 503, json: { error: "unavailable" } });
      connected = true;
      return route.fulfill({ json: { connected: true } });
    });
    await signup(page, `model-failure-${Date.now()}@rakazo.test`, "password12", "Fixture User");
    await completeAccountOnboarding(page);
    const settings = await openUserSettings(page, "models");
    if (locale === "zh-CN") {
      await page.evaluate(() => localStorage.setItem("rakazo.uiLocale", "zh-CN"));
      await page.reload();
      await expect(settings).toBeVisible();
    }
    const connectLabel = locale === "zh-CN" ? "同意并前往授权" : "Agree and authorize";
    const errorLabel = locale === "zh-CN" ? "模型账户暂时不可用" : "Model account unavailable";
    let popups = 0;
    page.on("popup", () => popups++);
    await settings.getByRole("button", { name: connectLabel, exact: true }).click();
    expect(popups).toBe(0);
    await expect(settings.getByRole("alert")).toHaveText(errorLabel);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(settings.getByRole("alert")).toHaveText(errorLabel);
    await expect(settings.getByRole("button", { name: connectLabel, exact: true })).toBeEnabled();
    await expect(
      settings.getByText(locale === "zh-CN" ? "已连接" : "Connected", {
        exact: true,
      }),
    ).toBeHidden();
    await captureScreenshot(page, testInfo, "model-account-connection-error");
    available = true;
    await settings.getByRole("button", { name: connectLabel, exact: true }).click();
    await expect(settings).toBeHidden();
    const settingsURL = new URL(page.url());
    settingsURL.searchParams.set("settings", "models");
    await page.goto(settingsURL.href);
    const connectedLabel = locale === "zh-CN" ? "已连接" : "Connected";
    await expect(settings.getByRole("status").filter({ hasText: connectedLabel })).toBeVisible();
    await expect(settings.getByRole("alert")).toBeHidden();
    await expect(settings.getByRole("button", { name: connectLabel, exact: true })).toBeHidden();
    await expect(
      settings.getByRole("button", { name: locale === "zh-CN" ? "取消" : "Cancel", exact: true }),
    ).toBeHidden();
    await expect(
      settings.getByRole("button", {
        name: locale === "zh-CN" ? "断开" : "Disconnect",
        exact: true,
      }),
    ).toBeHidden();
    await captureScreenshot(page, testInfo, "model-account-connected");
  });
}

for (const scenario of ["first", "renewed", "onboarding"]) {
  const reauthorizing = scenario === "renewed";
  const onboarding = scenario === "onboarding";
  test(`${scenario} authorization preserves the original conversation and unsent draft`, async ({
    page,
    context,
  }, testInfo) => {
    let connected = reauthorizing;
    let renewed = false;
    let callback = "";
    let popups = 0;
    page.on("popup", () => popups++);
    await page.route("**/api/model-account/config", (route) =>
      route.fulfill({
        json: {
          enabled: true,
          modelAccountOnly: true,
          serviceName: "Example",
          navigation: {
            cookieName: "one_nav",
            defaults: {
              homeUrl: "https://home.example.test/",
              rechargeUrl: "https://wallet.example.test/",
            },
            channels: [],
            productHosts: [],
          },
          modelId: "fixture-model",
        },
      }),
    );
    await page.route("**/api/model-account/status", (route) =>
      route.fulfill({
        json: {
          enabled: true,
          modelAccountOnly: true,
          connected,
          credentialId: connected ? "external-fixture" : undefined,
          linked: true,
          ...(!renewed && reauthorizing ? { recovery: "authorization_required" } : {}),
        },
      }),
    );
    await page.route("**/api/model-account/balance", (route) =>
      route.fulfill({ json: { amount: "10.00", unit: "USD" } }),
    );
    await page.route("**/api/model-account/connect", (route) => {
      callback = route.request().postDataJSON().callbackURL;
      return route.fulfill({
        json: { connected: false, url: "https://gateway.example.test/authorize" },
      });
    });
    await context.route("https://gateway.example.test/authorize", (route) => {
      connected = true;
      renewed = true;
      return route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(callback)})</script>`,
      });
    });
    await signup(page, `model-context-${Date.now()}@rakazo.test`, "password12", "Draft Keeper");
    await completeAccountOnboarding(page);
    const composer = page.getByRole("combobox", { name: /Message/ });
    await page.getByRole("button", { name: "Close model settings", exact: true }).click();
    if (!onboarding) await composer.fill("Keep this unsent draft");
    const conversation = page.url();
    const settings = onboarding
      ? page.getByRole("dialog", { name: "授权使用 Example 模型服务", exact: true })
      : await openUserSettings(page, "models");
    if (onboarding) {
      const me = await rpc<Me>(page, "me", {});
      await page.route("**/rpc/me", (route) =>
        route.fulfill({ json: { json: { ...me, needsModel: true } } }),
      );
      await page.evaluate(() => localStorage.setItem("rakazo.uiLocale", "zh-CN"));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/onboarding/model");
      await expect(settings).toBeVisible();
      await expect(
        settings.getByText(
          "授权后，本应用将通过你的 Example 账号调用模型服务。模型调用产生的费用将从你的 Example 账户余额中扣除。",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(settings.getByRole("button", { name: "刷新余额", exact: true })).toBeHidden();
      await expect(settings.getByRole("link")).toHaveCount(0);
      await expect(settings.getByRole("button")).toHaveCount(2);
    }
    const originalURL = page.url();
    if (onboarding) {
      await expect(settings.getByText("Main model", { exact: true })).toBeHidden();
      await captureScreenshot(page, testInfo, "first-account-authorization");
    }
    await settings
      .getByRole("button", {
        name: onboarding
          ? "同意并前往授权"
          : reauthorizing
            ? "Authorize again"
            : "Agree and authorize",
        exact: true,
      })
      .click();
    const destination = new URL(originalURL);
    if (onboarding) destination.searchParams.set("settings", "closed");
    else destination.searchParams.delete("settings");
    await expect(page).toHaveURL(destination.href);
    await expect(settings).toBeHidden();
    expect(popups).toBe(0);
    const returned = new URL(callback);
    expect(returned.searchParams.get("modelAccountAuthorization")).toBe("1");
    returned.searchParams.delete("modelAccountAuthorization");
    expect(returned.href).toBe(originalURL);
    expect(new URL(page.url()).searchParams.has("modelAccountAuthorization")).toBe(false);
    if (onboarding) {
      await expect(page.getByRole("heading", { name: "连接模型", exact: true })).toBeVisible();
      await captureScreenshot(page, testInfo, "model-account-onboarding-return");
    } else {
      await expect(composer).toHaveValue("Keep this unsent draft");
      expect(page.url()).toBe(conversation);
      await captureScreenshot(page, testInfo, `model-account-${scenario}-return`);
    }
  });
}

for (const failure of ["authorization_required", "result_unknown"] as const) {
  test(`authorization redirects back with ${failure} visible and no popup`, async ({
    page,
    context,
  }) => {
    let callback = "";
    let recovered = false;
    let popups = 0;
    page.on("popup", () => popups++);
    await page.route("**/api/model-account/config", (route) =>
      route.fulfill({ json: { enabled: true, modelAccountOnly: true } }),
    );
    await page.route("**/api/model-account/status", (route) =>
      route.fulfill({
        json: { enabled: true, modelAccountOnly: true, connected: recovered, linked: true },
      }),
    );
    await page.route("**/api/model-account/balance", (route) =>
      route.fulfill({ json: { amount: "10.00", unit: "USD" } }),
    );
    await page.route("**/api/model-account/connect", (route) => {
      if (recovered) return route.fulfill({ json: { connected: true } });
      callback = route.request().postDataJSON().callbackURL;
      return route.fulfill({
        json: { connected: false, url: "https://gateway.example.test/authorize" },
      });
    });
    await context.route("https://gateway.example.test/authorize", (route) => {
      const destination = new URL(callback);
      destination.searchParams.set("modelAccountError", failure);
      return route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(destination.href)})</script>`,
      });
    });
    await signup(
      page,
      `model-return-${failure}-${Date.now()}@rakazo.test`,
      "password12",
      "Fixture User",
    );
    await completeAccountOnboarding(page);
    const settings = await openUserSettings(page, "models");
    await settings.getByRole("button", { name: "Agree and authorize", exact: true }).click();
    await expect(settings.getByRole("alert")).toHaveText(
      failure === "authorization_required"
        ? "Authorize the model account to continue."
        : "Could not confirm authorization. Try again.",
    );
    expect(callback).not.toContain("/sso/callback");
    expect(popups).toBe(0);
    await expect(settings.getByText("Connected", { exact: true })).toBeHidden();
    recovered = true;
    await settings
      .getByRole("button", {
        name: failure === "authorization_required" ? "Authorize again" : "Retry",
        exact: true,
      })
      .click();
    await expect(settings).toBeHidden();
    expect(new URL(page.url()).searchParams.has("modelAccountError")).toBe(false);
  });
}

test("missing identity offers SSO directly and managed connections have no key editor", async ({
  page,
}, testInfo) => {
  await page.route("**/api/model-account/config", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        modelAccountOnly: true,
        navigation: {
          cookieName: "one_nav",
          defaults: {
            homeUrl: "https://home.example.test/",
            rechargeUrl: "https://wallet.example.test/",
          },
          channels: [],
          productHosts: [],
        },
        modelId: "fixture-model",
      },
    }),
  );
  await page.route("**/api/model-account/status", (route) =>
    route.fulfill({
      json: { enabled: true, modelAccountOnly: true, connected: false, linked: false },
    }),
  );
  await page.route("**/api/model-account/balance", (route) =>
    route.fulfill({ status: 403, json: { error: "link_required" } }),
  );
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "managed-fixture",
            provider: "openai-compatible",
            label: "Managed fixture connection",
            hasKey: true,
            isDefault: false,
            baseUrl: "https://models.example.test/v1",
          },
        ],
      },
    }),
  );
  await signup(page, `model-link-${Date.now()}@rakazo.test`, "password12", "Fixture User");
  await completeAccountOnboarding(page);
  const settings = await openUserSettings(page, "models");
  await expect(
    settings.getByRole("button", { name: "Continue with SSO", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Agree and authorize", exact: true }),
  ).toBeHidden();
  await expect(settings.getByTestId("model-provider-managed-fixture")).toHaveCount(0);
  await expect(settings.getByText("Main model", { exact: true })).toBeHidden();
  await captureScreenshot(page, testInfo, "account-authorization-required");
  const linking = page.waitForRequest("**/api/auth/link-social");
  await page.route("**/api/auth/link-social", (route) =>
    route.fulfill({ status: 400, json: { code: "LINKING_NOT_ALLOWED" } }),
  );
  const returnTo = page.url();
  await settings.getByRole("button", { name: "Continue with SSO", exact: true }).click();
  expect((await linking).postDataJSON()).toMatchObject({
    provider: "oidc",
    callbackURL: returnTo,
    errorCallbackURL: returnTo,
  });
  await expect(settings.getByRole("alert")).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Continue with SSO", exact: true }),
  ).toBeEnabled();
  expect(page.url()).toBe(returnTo);
});

test("unknown authorization is checked automatically and retry appears only after failure", async ({
  page,
}) => {
  let connected = false;
  let available = false;
  let checks = 0;
  let authorizations = 0;
  await page.route("**/api/model-account/config", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        modelAccountOnly: true,
        navigation: {
          cookieName: "one_nav",
          defaults: {
            homeUrl: "https://home.example.test/",
            rechargeUrl: "https://wallet.example.test/",
          },
          channels: [],
          productHosts: [],
        },
        modelId: "fixture-model",
      },
    }),
  );
  await page.route("**/api/model-account/status", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        modelAccountOnly: true,
        linked: true,
        connected,
        credentialId: connected ? "external-fixture" : undefined,
        ...(!connected ? { recovery: "authorization_unknown" } : {}),
      },
    }),
  );
  await page.route("**/api/model-account/balance", (route) =>
    route.fulfill({ json: { amount: "10.00", unit: "USD" } }),
  );
  await page.route("**/api/model-account/connect", (route) => {
    authorizations++;
    return route.fulfill({ status: 500, json: { error: "unavailable" } });
  });
  await page.route("**/api/model-account/recover", (route) => {
    checks++;
    if (!available) return route.fulfill({ status: 503, json: { error: "unavailable" } });
    connected = true;
    return route.fulfill({ json: { connected: true } });
  });
  await signup(page, `model-recovery-${Date.now()}@rakazo.test`, "password12", "Fixture User");
  await completeAccountOnboarding(page);
  const settings = await openUserSettings(page, "models");
  await expect(settings.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  expect(checks).toBeGreaterThan(0);
  await expect(settings.getByRole("button", { name: "Authorize again", exact: true })).toBeHidden();
  available = true;
  await settings.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(settings).toBeHidden();
  expect(authorizations).toBe(0);
});

test("account-only settings retain model choices without ordinary connection controls", async ({
  page,
}, testInfo) => {
  await signup(page, `account-only-${Date.now()}@rakazo.test`, "password12", "Fixture User");
  await completeAccountOnboarding(page, false);
  let configured = false;
  await page.route("**/api/model-account/config", (route) =>
    route.fulfill({ json: { enabled: configured, modelAccountOnly: true } }),
  );
  await page.route("**/api/model-account/status", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        modelAccountOnly: true,
        connected: true,
        credentialId: "external-fixture",
        linked: true,
      },
    }),
  );
  await page.route("**/api/model-account/balance", (route) =>
    route.fulfill({ json: { amount: "12.34", unit: "USD" } }),
  );
  const choice = {
    provider: "openai-compatible",
    modelId: "fixture-model",
    credentialId: "external-fixture",
  };
  const entries = [
    {
      provider: choice.provider,
      id: choice.modelId,
      label: "Fixture model",
      providerName: "Model account",
      credentialIds: [choice.credentialId],
    },
    {
      provider: choice.provider,
      id: "fixture-backup",
      label: "Fixture backup",
      credentialIds: [choice.credentialId],
    },
  ];
  await page.route("**/rpc/models/list", (route) => route.fulfill({ json: { json: entries } }));
  await page.route("**/rpc/models/forRole", (route) => route.fulfill({ json: { json: entries } }));
  await page.route("**/rpc/models/role", (route) =>
    route.fulfill({ json: { json: { primary: choice, backups: [], deploymentPrimary: null } } }),
  );
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: choice.credentialId,
            label: "Model account",
            provider: choice.provider,
            modelId: choice.modelId,
            enabledModelIds: [choice.modelId, "fixture-backup"],
          },
        ],
      },
    }),
  );
  await page.reload();
  const settings = await openUserSettings(page, "models");
  await expect(settings.getByRole("alert")).toHaveText("Model account unavailable");
  await expect(settings.getByRole("button", { name: "Add provider", exact: true })).toBeHidden();
  configured = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(settings.getByText("Connected", { exact: true })).toBeVisible();
  await expect(settings.getByText("Providers", { exact: true })).toBeHidden();
  await expect(settings.getByRole("button", { name: "Add provider", exact: true })).toBeHidden();
  await expect(settings.getByText("Main model", { exact: true })).toBeVisible();
  await expect(settings.getByText("Approval model", { exact: true })).toBeVisible();
  await expect(settings.getByTestId("settings-nav-voice")).toBeVisible();
  await captureScreenshot(page, testInfo, "model-account-only-settings");
  await settings.getByRole("button", { name: "Add fallback", exact: true }).first().click();
  await expect(page.getByRole("option", { name: /Fixture backup/ })).toBeVisible();
  await expect(page.getByRole("option").filter({ hasText: "Connect" })).toHaveCount(0);
});

test("model account navigation keeps ordinary memory and voice settings available", async ({
  page,
}, testInfo) => {
  await signup(page, `account-memory-${Date.now()}@rakazo.test`, "password12", "Fixture User");
  await completeAccountOnboarding(page, false);
  await page.reload();
  const settings = await openUserSettings(page, "memory");
  await expect(settings.getByTestId("settings-nav-voice")).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Connect memory provider", exact: true }),
  ).toBeVisible();
  await expect(settings.getByTestId("memory-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "model-account-local-memory");
});
