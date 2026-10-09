import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

async function patchJson(route: Route, patch: (body: { json?: Record<string, unknown> }) => void) {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  patch(body);
  await route.fulfill({ response, json: body });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stopComputer(computer: unknown) {
  const record = asRecord(computer);
  if (!record) return;
  record.state = "stopped";
  record.screenAvailable = false;
}

test("unavailable computers explain setup and open computer settings", async ({
  page,
}, testInfo) => {
  await signup(page, `computers-off-${Date.now()}@rakazo.test`, "password12", "Computers Off");
  await completeOnboarding(page);
  await page.route("**/rpc/me", (route) =>
    patchJson(route, (body) => {
      if (!body.json) return;
      body.json.sandboxProvider = "none";
      body.json.isDeploymentOwner = true;
    }),
  );
  await page.route("**/rpc/bootstrap", (route) =>
    patchJson(route, (body) => {
      const me = asRecord(body.json?.me);
      if (me) {
        me.sandboxProvider = "none";
        me.isDeploymentOwner = true;
      }
      const thread = asRecord(body.json?.thread);
      stopComputer(thread?.computer);
    }),
  );
  for (const procedure of ["computer/status", "computer/boot"]) {
    await page.route(`**/rpc/${procedure}`, (route) =>
      patchJson(route, (body) => stopComputer(body.json)),
    );
  }
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({ json: { json: { url: null } } }),
  );
  await page.route("**/rpc/threads/get", (route) =>
    patchJson(route, (body) => stopComputer(body.json?.computer)),
  );
  await page.reload();

  await page.getByTitle("Agent computer").click();
  const preview = page.getByTestId("computer-preview");
  const hint = preview.getByTestId("computers-unavailable-hint");
  await expect(hint).toBeVisible();
  await expect(hint.getByText(/Computers are off/)).toBeVisible();
  await expect(hint.getByRole("button", { name: "Check again" })).toBeVisible();
  await expect(hint.getByRole("button", { name: "Open computer settings" })).toBeVisible();
  await expect(hint.getByRole("button", { name: "Copy .env example" })).toBeVisible();
  await expect(preview.getByTestId("computer-preview-open")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computers-unavailable-preview");

  await hint.getByRole("button", { name: "Check again" }).click();
  await expect(hint.getByText(/Computers are off/)).toBeVisible();
  await expect(hint.getByRole("button", { name: "Check again" })).toBeEnabled();

  await hint.getByRole("button", { name: "Open computer settings" }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("data-settings-section", "computer");
  await expect(settings.getByTestId("computers-setup-settings")).toBeVisible();
  await expect(settings.getByTestId("settings-nav-computer")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await captureScreenshot(page, testInfo, "computers-unavailable-settings");
});
