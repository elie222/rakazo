import { createServer } from "node:net";
import { expect, test } from "@playwright/test";
import { openBrowserAuth } from "../../desktop/src/browser-auth";
import { captureScreenshot } from "./helpers";

test("browser sign-in returns a callback and shows the return-to-app message", async ({
  page,
}, testInfo) => {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing callback port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const callback = `http://127.0.0.1:${address.port}/callback`;
  const authorization = new URL("https://provider.example.com/authorize");
  authorization.searchParams.set("redirect_uri", callback);
  authorization.searchParams.set("state", "example-state");
  const controller = new AbortController();
  const received: unknown[] = [];
  try {
    await openBrowserAuth(authorization.href, {
      signal: controller.signal,
      // Simulate the provider redirect without contacting a provider.
      openExternal: async () => {
        await page.goto(`${callback}?code=example-code&state=example-state`);
      },
      onCallback: (value) => received.push(value),
    });
    await expect(page.getByText("You can close this tab and return to Rakazo.")).toBeVisible();
    expect(received).toEqual([{ code: "example-code", state: "example-state" }]);
    await captureScreenshot(page, testInfo, "browser-auth-complete");
  } finally {
    controller.abort();
  }
});
