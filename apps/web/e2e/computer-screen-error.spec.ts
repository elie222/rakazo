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

  failScreen = false;
  await preview.getByRole("button", { name: "Retry screen" }).click();
  await expect(preview.locator("iframe")).toHaveAttribute("src", screenUrl);
  await expect(preview.getByRole("alert")).toHaveCount(0);

  failScreen = true;
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("temporarily busy");
  await captureScreenshot(page, testInfo, "computer-full-screen-connection-error");

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
  await expect(preview.getByRole("alert")).toContainText("Failed to connect to server");
  await expect(preview.locator("iframe")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-screen-frame-failed");

  outcome = "connected";
  await preview.getByRole("button", { name: "Retry screen" }).click();
  await expect(preview.locator("iframe")).toHaveAttribute("src", /1\.frame-test\/vnc\.html/);
  await expect(preview.getByRole("alert")).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(preview.getByRole("alert")).toHaveCount(0);
});

test("a framed screen the proxy refuses shows the proxy's reason", async ({ page }, testInfo) => {
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
  await expect(preview.getByRole("alert")).toContainText("Invalid or expired screen capability");
  await expect(preview.locator("iframe")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-screen-frame-refused");
});

test("a framed screen that drops after connecting loads again by itself once", async ({ page }) => {
  await signup(page, `screen-drop-${Date.now()}@rakazo.test`, "password12", "Screen Drop");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });

  // The first load connects and then loses its socket, as when the proxy closes it. The app
  // also asks for the page with fetch: on opening, then while it waits to reconnect, when the
  // first two answers say the access check couldn't reach the API.
  let loads = 0;
  let probes = 0;
  let dropAt = 0;
  let reloadedAt = 0;
  await page.route("**/novnc/session/view/1.drop-test/**", (route) => {
    const document = route.request().resourceType() === "document";
    if (!document) {
      probes += 1;
      if (probes === 2 || probes === 3) {
        return route.fulfill({
          status: 503,
          contentType: "text/plain",
          body: "Screen unavailable",
        });
      }
    }
    if (document) {
      loads += 1;
      if (loads === 2) reloadedAt = Date.now();
    }
    const drop = document && loads === 1;
    if (drop) dropAt = Date.now() + 300;
    return route.fulfill({
      contentType: "text/html",
      headers: { "content-security-policy": "sandbox allow-scripts allow-pointer-lock" },
      body: `<!doctype html><title>Test desktop</title><script>
        parent.postMessage({ rakazoScreen: "loading" }, "*");
        parent.postMessage({ rakazoScreen: "connected" }, "*");
        ${drop ? 'setTimeout(() => parent.postMessage({ rakazoScreen: "disconnected" }, "*"), 300);' : ""}
      </script><p>Desktop</p>`,
    });
  });
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        json: { url: "/novnc/session/view/1.drop-test/vnc.html?autoconnect=true" },
      }),
    }),
  );

  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview.locator("iframe")).toHaveAttribute("src", /1\.drop-test\/vnc\.html/);
  // The drop loads the page again without a click, and no error shows meanwhile or after.
  await expect.poll(() => loads).toBe(2);
  // It waited out the two unavailable answers before loading again.
  expect(probes).toBeGreaterThanOrEqual(4);
  expect(reloadedAt - dropAt).toBeGreaterThanOrEqual(2_500);
  await page.waitForTimeout(1_000);
  await expect(preview.getByRole("alert")).toHaveCount(0);
  await expect(preview.locator("iframe")).toHaveCount(1);

  // Another drop within the half minute is left to the user.
  const frame = page.frames().find((candidate) => candidate.url().includes("1.drop-test"));
  await frame?.evaluate(() => parent.postMessage({ rakazoScreen: "disconnected" }, "*"));
  await expect(preview.getByRole("alert")).toContainText(
    "Could not connect to the computer screen",
  );
  await expect(preview.getByRole("button", { name: "Retry screen" })).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(loads).toBe(2);
});

for (const moved of [false, true]) {
  test(
    moved
      ? "a reconnected screen leaves the keyboard in the chat box the user moved to"
      : "a reconnected screen that had the keyboard gets it back",
    async ({ page }) => {
      await signup(page, `screen-focus-${Date.now()}@rakazo.test`, "password12", "Screen Focus");
      await completeOnboarding(page);
      const botId = activeBotId(page);
      await rpc(page, "computer/boot", { botId });
      await expect(
        rpc<{ state: string }>(page, "computer/status", { botId }),
      ).resolves.toMatchObject({ state: "running" });

      // Each load connects and stays up; the wait after the drop sees two unavailable answers,
      // which leaves time to move the keyboard.
      let loads = 0;
      let probes = 0;
      await page.route("**/novnc/session/view/1.focus-test/**", (route) => {
        if (route.request().resourceType() === "document") loads += 1;
        else {
          probes += 1;
          if (probes === 2 || probes === 3) {
            return route.fulfill({ status: 503, contentType: "text/plain", body: "" });
          }
        }
        return route.fulfill({
          contentType: "text/html",
          headers: { "content-security-policy": "sandbox allow-scripts allow-pointer-lock" },
          body: `<!doctype html><title>Test desktop</title><script>
            parent.postMessage({ rakazoScreen: "loading" }, "*");
            parent.postMessage({ rakazoScreen: "connected" }, "*");
          </script><p>Desktop</p>`,
        });
      });
      await page.route("**/rpc/computer/screenUrl", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ json: { url: "/novnc/session/view/1.focus-test/vnc.html" } }),
        }),
      );

      await page.getByRole("button", { name: "Agent computer", exact: true }).click();
      const preview = page.getByTestId("computer-preview");
      await expect(preview.locator("iframe")).toHaveAttribute("src", /1\.focus-test\/vnc\.html/);
      await preview.locator("iframe").focus();
      const frame = page.frames().find((candidate) => candidate.url().includes("1.focus-test"));
      await frame?.evaluate(() => parent.postMessage({ rakazoScreen: "disconnected" }, "*"));
      if (moved) await page.locator('[role="combobox"][aria-label^="Message"]').first().focus();

      await expect.poll(() => loads).toBe(2);
      await page.waitForTimeout(500);
      const focused = await page.evaluate(() => {
        const active = document.activeElement;
        return active?.getAttribute("aria-label")?.startsWith("Message")
          ? "chat box"
          : active?.tagName;
      });
      expect(focused).toBe(moved ? "chat box" : "IFRAME");
    },
  );
}
