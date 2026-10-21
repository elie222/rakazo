import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

const screenUrl = "https://screen.example/vnc.html";

async function routeScreen(page: Page) {
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test desktop</title><p>Desktop connected</p>",
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: screenUrl } }),
    }),
  );
}

test("a booting computer can be closed and keeps booting", async ({ page }, testInfo) => {
  await signup(page, `boot-leave-${Date.now()}@rakazo.test`, "password12", "Boot Leave");
  await completeOnboarding(page);
  await routeScreen(page);
  const held: Route[] = [];
  await page.route("**/rpc/computer/boot", (route) => {
    held.push(route);
  });

  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview).toContainText("Computer is stopped");
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect.poll(() => held.length).toBe(1);

  // The boot shows inside the computer window, which keeps its Close button.
  const close = page.getByRole("button", { name: "Close computer" });
  await expect(close).toBeVisible();
  await expect(page.getByText("Booting live desktop…")).toBeVisible();
  await expect(page.getByText(/Booting up/)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-booting-inline");

  await page.keyboard.press("Escape");
  await expect(close).toHaveCount(0);
  await expect(preview).toContainText("Booting live desktop…");

  // Reopening shows the same boot without starting another one.
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(close).toBeVisible();
  await close.click();
  await expect(close).toHaveCount(0);
  expect(held).toHaveLength(1);

  const response = await held[0]!.fetch();
  await held[0]!.fulfill({ response });
  await expect(preview.locator("iframe")).toHaveAttribute("src", screenUrl);
  await expect(close).toHaveCount(0);
});

test("a failed boot can be retried from the computer window", async ({ page }) => {
  await signup(page, `boot-retry-${Date.now()}@rakazo.test`, "password12", "Boot Retry");
  await completeOnboarding(page);
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test desktop</title><p>Desktop connected</p>",
    }),
  );
  let fail = true;
  // Screen reads that race the failed boot are held, then answered as the server answers for a
  // computer that is not running: no URL and no error.
  const heldScreens: Route[] = [];
  await page.route("**/rpc/computer/screenUrl", (route) => {
    if (fail) heldScreens.push(route);
    else
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ json: { url: screenUrl } }),
      });
  });
  await page.route("**/rpc/computer/boot", async (route) => {
    if (!fail) return route.continue();
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          defined: false,
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
          message: "Boot failed",
        },
      }),
    });
  });

  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview).toContainText(/Computer is stopped|Computer failed to boot/);
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();

  await expect.poll(() => heldScreens.length).toBeGreaterThan(0);
  for (const route of heldScreens.splice(0)) {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: null } }),
    });
  }
  await expect(alert).toContainText("Boot failed");
  await expect(alert.getByRole("button", { name: "Retry screen" })).toBeVisible();

  fail = false;
  await alert.getByRole("button", { name: "Retry screen" }).click();
  await expect(page.locator('iframe[title="Bot screen"]')).toHaveAttribute("src", screenUrl);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("starting another bot's computer is not blocked by a boot still under way", async ({
  page,
}) => {
  await signup(page, `boot-two-${Date.now()}@rakazo.test`, "password12", "Boot Two");
  await completeOnboarding(page);
  const first = activeBotId(page);
  const second = await createNamedBot(page, "Bravo", { computerMode: "dedicated" });
  const held: { route: Route; botId: string }[] = [];
  await page.route("**/rpc/computer/boot", (route) => {
    const body = route.request().postDataJSON() as { json?: { botId?: string } };
    held.push({ route, botId: body.json?.botId ?? "" });
  });

  await page.goto(`/app/${first}`);
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview).toContainText("Computer is stopped");
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect.poll(() => held.map((boot) => boot.botId)).toEqual([first]);
  const close = page.getByRole("button", { name: "Close computer" });
  await close.click();
  await expect(close).toHaveCount(0);

  await page.getByText("Bravo", { exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/app/${second}`));
  if (!(await preview.isVisible())) {
    await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  }
  // The other bot's computer is stopped, not booting.
  await expect(preview).toContainText("Computer is stopped");
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect.poll(() => held.map((boot) => boot.botId)).toEqual([first, second]);
  await expect(close).toBeVisible();
  await expect(page.getByText("Booting live desktop…").first()).toBeVisible();
});

test("opening a computer the server reports as booting does not start a second boot", async ({
  page,
}) => {
  await signup(page, `boot-server-${Date.now()}@rakazo.test`, "password12", "Boot Server");
  await completeOnboarding(page);
  // Another tab or the phone started this computer; the server reports it booting.
  await page.route("**/rpc/threads/get", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: { computer?: { state?: string } } };
    if (body.json?.computer) body.json.computer.state = "booting";
    await route.fulfill({ response, json: body });
  });
  const boots: Route[] = [];
  await page.route("**/rpc/computer/boot", (route) => {
    boots.push(route);
  });

  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview).toContainText("Booting live desktop…");
  const bootsBefore = boots.length;
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.getByText("Booting live desktop…").first()).toBeVisible();
  expect(boots).toHaveLength(bootsBefore);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Retry screen clears a failed takeover on a running computer", async ({ page }) => {
  await signup(page, `boot-takeover-${Date.now()}@rakazo.test`, "password12", "Boot Takeover");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });
  await routeScreen(page);
  await page.route("**/rpc/computer/takeover", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          defined: false,
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
          message: "Takeover failed",
        },
      }),
    }),
  );

  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview.locator("iframe")).toHaveAttribute("src", screenUrl);
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  const screen = page.locator('iframe[title="Bot screen"]');
  await expect(screen).toHaveAttribute("src", screenUrl);
  await page
    .getByTestId("computer-chrome")
    .getByRole("button", { name: "Take control", exact: true })
    .click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Takeover failed");
  await expect(screen).toHaveCount(0);

  await alert.getByRole("button", { name: "Retry screen" }).click();
  await expect(screen).toHaveAttribute("src", screenUrl);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
