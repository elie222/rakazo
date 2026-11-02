import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

async function useDockerComputers(route: Route) {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = (body.json?.me ?? body.json) as Record<string, unknown> | undefined;
  if (me) me.sandboxProvider = "docker";
  await route.fulfill({ response, json: body });
}

test("an account picks its own Wuying computer and pastes the gateway config", async ({
  page,
}, testInfo) => {
  // Nothing is saved: the form never contacts Wuying.
  await signup(page, `own-computer-${Date.now()}@rakazo.test`, "password12", "Own computer");
  await completeOnboarding(page);
  await page.route("**/rpc/me", useDockerComputers);
  await page.route("**/rpc/bootstrap", useDockerComputers);
  // Admins edit the deployment's choice and everyone else their own; both start on the default.
  await page.route(/\/rpc\/computerProvider\/(account\/)?get(\?|$)/, (route) =>
    route.fulfill({
      json: { json: { provider: "default", defaultProvider: "docker", wuying: null } },
    }),
  );
  await page.reload();

  const settings = await openUserSettings(page, "computer");
  const form = settings.getByTestId("computer-provider-settings");
  const provider = form.getByLabel("New computers run on");
  await expect(provider).toHaveValue("default");
  await expect(form.getByLabel("Desktop ID")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-provider-account-default");

  await provider.selectOption("wuying");
  await form.getByLabel("Desktop ID").fill("ecd-example");
  await form.getByLabel("End user ID").fill("example-user");
  await form.getByLabel("MCP gateway URL").fill(
    JSON.stringify({
      mcpServers: {
        wuying: {
          url: "https://gw-example.cn-hangzhou.aigclinks.com:8019/mcp",
          headers: { Authorization: "Bearer example-token" },
        },
      },
    }),
  );
  await expect(form.getByLabel("MCP gateway URL")).toHaveValue(
    "https://gw-example.cn-hangzhou.aigclinks.com:8019/mcp",
  );
  await expect(form.getByLabel("MCP token")).toHaveValue("example-token");
  await captureScreenshot(page, testInfo, "computer-provider-account-wuying");
});
