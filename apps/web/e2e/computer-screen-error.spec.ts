import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("screen connection failures stay visible and can be retried", async ({ page }, testInfo) => {
  await signup(page, `screen-error-${Date.now()}@rakazo.test`, "password12", "Screen Error");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });

  let failScreen = true;
  const screenUrl = "https://screen.example/vnc.html";
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test desktop</title><p>Desktop connected</p>",
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      status: failScreen ? 409 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        failScreen
          ? {
              json: {
                defined: false,
                code: "CONFLICT",
                status: 409,
                message:
                  "The computer screen is temporarily busy. Retry in a moment. File and shell tools still work.",
              },
            }
          : { json: { url: screenUrl } },
      ),
    }),
  );

  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview.getByRole("alert")).toContainText("temporarily busy");
  await expect(preview.getByTestId("computer-preview-open")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-screen-connection-error");

  await expect(preview.getByRole("alert")).toContainText("Screen not connected");
  await preview.getByRole("button", { name: "Recover computer", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Recover computer?");
  await captureScreenshot(page, testInfo, "computer-screen-recover-confirm");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  failScreen = false;
  await preview.getByRole("button", { name: "Retry screen" }).click();
  await expect(preview.locator("iframe")).toHaveAttribute("src", screenUrl);
  await expect(preview.getByRole("alert")).toHaveCount(0);

  await captureScreenshot(page, testInfo, "computer-screen-healthy");
  failScreen = true;
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("temporarily busy");
  await captureScreenshot(page, testInfo, "computer-full-screen-connection-error");

  await page
    .getByRole("alert")
    .getByRole("button", { name: "Recover computer", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText("Recover computer?");
  await captureScreenshot(page, testInfo, "computer-full-screen-recover-confirm");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  failScreen = false;
  await page.getByRole("button", { name: "Retry screen" }).click();
  await expect(page.locator('iframe[title="Bot screen"]')).toHaveAttribute("src", screenUrl);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a framed screen that fails to connect says so and can be retried", async ({
  page,
}, testInfo) => {
  await signup(page, `screen-frame-${Date.now()}@rakazo.test`, "password12", "Screen Frame");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });

  // What the proxy would serve: the page runs, then noVNC gives up on its socket.
  let outcome: "failed" | "connected" = "failed";
  const screenPath = "/novnc/session/view/1.frame-test/vnc.html?autoconnect=true";
  await page.route("**/novnc/session/view/1.frame-test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: { "content-security-policy": "sandbox allow-scripts allow-pointer-lock" },
      body: `<!doctype html><title>Test desktop</title><script>
        parent.postMessage({ rakazoScreen: "loading" }, "*");
        parent.postMessage(${JSON.stringify(
          outcome === "failed"
            ? { rakazoScreen: "failed", detail: "Failed to connect to server" }
            : { rakazoScreen: "connected" },
        )}, "*");
      </script><p>Desktop</p>`,
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: { url: screenPath } }),
    }),
  );

  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview.getByRole("alert")).toContainText(
    "Could not connect to the computer screen",
  );
  await expect(preview.locator("iframe")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-screen-frame-failed");

  outcome = "connected";
  await preview.getByRole("button", { name: "Retry screen" }).click();
  await expect(preview.locator("iframe")).toHaveAttribute("src", /1\.frame-test\/vnc\.html/);
  await expect(preview.getByRole("alert")).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(preview.getByRole("alert")).toHaveCount(0);
});

test("a refused screen shows a fixed localized reason", async ({ page }, testInfo) => {
  await signup(page, `screen-refused-${Date.now()}@rakazo.test`, "password12", "Screen Refused");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });
  await page.route("**/novnc/session/view/1.refused-test/**", (route) =>
    route.fulfill({
      status: 403,
      contentType: "text/plain",
      body: "Invalid or expired screen capability",
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: { url: "/novnc/session/view/1.refused-test/vnc.html" } }),
    }),
  );
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview.getByRole("alert")).toContainText("The screen link expired.");
  await expect(preview.locator("iframe")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-screen-frame-refused");
});

test("a running computer without a screen URL offers recovery", async ({ page }, testInfo) => {
  await signup(page, `screen-missing-${Date.now()}@rakazo.test`, "password12", "Screen Missing");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: null } }),
    }),
  );
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview.getByRole("alert")).toContainText("Screen not connected");
  await expect(preview.getByRole("button", { name: "Retry screen" })).toBeVisible();
  await expect(
    preview.getByRole("button", { name: "Recover computer", exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-screen-url-missing");
});

test("a healthy running computer is not diagnosed while its screen URL loads", async ({
  page,
}, testInfo) => {
  await signup(page, `screen-loading-${Date.now()}@rakazo.test`, "password12", "Screen Loading");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  const screenUrl = "https://screen.example/vnc.html";
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Desktop connected</title>",
    }),
  );
  let readStarted!: () => void;
  const reading = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  await page.route("**/rpc/computer/screenUrl", async (route) => {
    readStarted();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: screenUrl } }),
    });
  });
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  await reading;
  const preview = page.getByTestId("computer-preview");
  await expect(preview.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Screen not connected", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-screen-url-loading");
  await expect(preview.locator("iframe")).toHaveAttribute("src", screenUrl);
  await expect(preview.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Screen not connected", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-screen-url-loaded");
});

test("a takeover failure does not diagnose a screen connection failure", async ({
  page,
}, testInfo) => {
  await signup(page, `screen-control-${Date.now()}@rakazo.test`, "password12", "Screen Control");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Desktop</title>" }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: "https://screen.example/vnc.html" } }),
    }),
  );
  await page.route("**/rpc/computer/takeover", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          defined: false,
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
          message: "Could not take control",
        },
      }),
    }),
  );
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview.locator("iframe")).toBeVisible();
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not take control");
  await expect(page.getByText("Screen not connected", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("alert").getByRole("button", { name: "Recover computer", exact: true }),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-takeover-error");
});
