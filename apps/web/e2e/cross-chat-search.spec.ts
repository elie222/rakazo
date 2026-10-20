import { expect, test } from "@playwright/test";
import { crossChatGallery } from "../../../packages/testkit/src/cli/cross-chat-gallery";
import { captureScreenshot } from "./helpers";

test("finds and verifies an earlier chat with another bot", async ({ page, baseURL }, testInfo) => {
  const fixture = await crossChatGallery(baseURL!);
  const pending = new Set<AbortController>();
  try {
    // The fixture owns a separate disposable database. Render its completed real run
    // through the same RPC/auth surface, without affecting parallel scripted journeys.
    await page.route(/\/(rpc|api)\//, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.includes("/events")) {
        await route.abort();
        return;
      }
      const controller = new AbortController();
      pending.add(controller);
      const response = await fixture.app.request(url.pathname + url.search, {
        signal: controller.signal,
        method: request.method(),
        headers: { ...request.headers(), cookie: fixture.cookie },
        ...(request.postData() ? { body: request.postData()! } : {}),
      });
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        controller.abort();
        pending.delete(controller);
        await route.abort();
        return;
      }
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
      pending.delete(controller);
    });
    await page.addInitScript(() => localStorage.setItem("rakazo.showToolActivity", "on"));
    await page.goto(`/app/${fixture.botId}`);
    const transcript = page.getByTestId("transcript");
    await expect(
      transcript.getByText("Researcher recorded the Quasar launch code: VIOLET-APRICOT-731."),
    ).toBeVisible();
    const cards = transcript.getByTestId("tool-activity");
    for (const card of await cards.all()) {
      if (!(await card.evaluate((element) => (element as HTMLDetailsElement).open)))
        await card.locator("summary").click();
    }
    await expect(transcript.getByText("Search history", { exact: true })).toBeVisible();
    await expect(transcript.getByText("Read history", { exact: true })).toBeVisible();
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
      await captureScreenshot(page, testInfo, `cross-chat-search-${viewport.width}`);
    }
  } finally {
    try {
      for (const controller of pending) controller.abort();
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "ignoreErrors" });
    } finally {
      await fixture.cleanup();
    }
  }
});
