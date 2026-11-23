import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { deferred } from "@rakazo/core/test-async";
import {
  captureScreenshot,
  completeOnboarding,
  openModelConnection,
  openUserSettings,
  signup,
} from "../helpers/helpers";

const probePath = "**/rpc/models/probeOpenAiCompatible";

const edits = {
  add: (page: Page) => page.getByRole("button", { name: "Add header", exact: true }).click(),
  name: (page: Page) => page.getByLabel("Header name", { exact: true }).first().fill("x-updated"),
  value: (page: Page) =>
    page.getByLabel("Header value", { exact: true }).first().fill("updated-fixture"),
  remove: (page: Page) =>
    page.getByRole("button", { name: "Remove header", exact: true }).first().click(),
};

for (const surface of ["settings", "onboarding"] as const) {
  for (const [action, edit] of Object.entries(edits)) {
    test(`${surface} header ${action} clears discovered models and ignores an in-flight result`, async ({
      page,
    }, testInfo) => {
      if (surface === "onboarding") {
        await page.route("**/rpc/me", async (route) => {
          const response = await route.fetch();
          const body = (await response.json()) as { json: Record<string, unknown> };
          await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
        });
      }
      await signup(
        page,
        `header-${surface}-${action}-${Date.now()}@rakazo.test`,
        "password12",
        "Header discovery",
      );
      if (surface === "settings") {
        await completeOnboarding(page);
        await openUserSettings(page, "models");
        await openModelConnection(page, "OpenAI-compatible");
      } else {
        await page.getByRole("combobox", { name: "Provider", exact: true }).click();
        await page.getByRole("option", { name: "OpenAI-compatible", exact: true }).click();
      }
      const pending = deferred<void>();
      await page.route(probePath, async (route) => {
        const { headers } = route.request().postDataJSON().json as {
          headers?: Record<string, string>;
        };
        const value = headers?.["x-fixture"];
        if (value === "held-fixture") await pending.promise;
        const models =
          value === "fixture-value"
            ? ["old-header-model"]
            : value === "held-fixture"
              ? ["stale-header-model"]
              : [];
        await route.fulfill({ json: { json: { models } } });
      });
      await page.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8090/v1");
      await page.getByLabel("Model id", { exact: true }).fill("manual-model");
      await page.getByText("Advanced", { exact: true }).click();
      await page.getByRole("button", { name: "Add header", exact: true }).click();
      await page.getByLabel("Header name", { exact: true }).fill("x-fixture");
      const headerValue = page.getByLabel("Header value", { exact: true });
      await headerValue.fill("fixture-value");
      const useFound = page.getByRole("button", { name: "Use a found model", exact: true });
      await expect(useFound).toBeVisible();

      const request = page.waitForRequest(probePath);
      const response = page.waitForResponse(
        (response) =>
          response.url().endsWith("/rpc/models/probeOpenAiCompatible") &&
          response.request().postDataJSON().json.headers?.["x-fixture"] === "held-fixture",
      );
      try {
        await headerValue.fill("held-fixture");
        await request;
        await expect(page.getByText("Finding…", { exact: true })).toBeVisible();
        await edit(page);
        await expect(useFound).toHaveCount(0);
        await expect(page.getByLabel("Model id", { exact: true })).toHaveValue("manual-model");
      } finally {
        pending.resolve();
      }
      await (await response).finished();
      // Let the RPC continuation and React's render run before checking stale state.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(useFound).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: "Models from server" })).toHaveCount(0);
      await expect(page.getByLabel("Model id", { exact: true })).toHaveValue("manual-model");
      if (action === "remove")
        await captureScreenshot(page, testInfo, `${surface}-header-discovery-reset`);
    });
  }
}
