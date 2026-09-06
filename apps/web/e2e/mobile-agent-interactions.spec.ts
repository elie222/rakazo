import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

test("mobile inbox pins chats, creates groups and offers attachment sources", async ({
  page,
}, testInfo) => {
  await signup(page, `mobile-inbox-${Date.now()}@rakazo.test`, "password12", "Mobile Inbox");
  await completeOnboarding(page);
  const chief = activeBotId(page);
  await createNamedBot(page, "Researcher");
  await rpc(page, "bots/update", { botId: chief, pinned: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await page.getByRole("button", { name: "Open navigation" }).click();
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toBeVisible();
  expect((await sidebar.boundingBox())!.width).toBe(390);
  await captureScreenshot(page, testInfo, "mobile-pinned-inbox");
  await page.getByRole("button", { name: "Search conversations", exact: true }).click();
  await page.getByRole("textbox", { name: "Search conversations", exact: true }).fill("Researcher");
  await expect(sidebar.getByText("Researcher", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search conversations", exact: true }).fill("");
  await page.getByTestId("create-menu-trigger").click();
  await expect(page.getByTestId("create-new-group")).toHaveText("New group chat");
  await captureScreenshot(page, testInfo, "mobile-create-menu");
  await page.getByTestId("create-new-group").click();
  await expect(page.getByText("New group", { exact: true })).toBeVisible();
  await expect(sidebar).toHaveAttribute("inert", "");
  await page.getByPlaceholder("Name this group").fill("Project team");
  await page
    .getByRole("button", { name: "Chief", exact: true })
    .and(page.locator("[aria-pressed]"))
    .click();
  await page
    .getByRole("button", { name: "Researcher", exact: true })
    .and(page.locator("[aria-pressed]"))
    .click();
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\//);
  await captureScreenshot(page, testInfo, "mobile-group-created");
  await page.getByRole("button", { name: "Attach file", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Attach image", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Take photo", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "mobile-attachment-sources");
  const photoChooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Take photo", exact: true }).click();
  const camera = await photoChooser;
  expect(camera.isMultiple()).toBe(false);
  expect(await camera.element().getAttribute("capture")).toBe("environment");
  await camera.setFiles([]);
  await page.getByRole("button", { name: "Attach file", exact: true }).click();
  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Choose file", exact: true }).click();
  const files = await fileChooser;
  expect(files.isMultiple()).toBe(true);
  expect(await files.element().getAttribute("capture")).toBeNull();
  await files.setFiles({
    name: "brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A short project brief."),
  });
  await expect(page.getByText("brief.txt", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "mobile-attachment-ready");
});

test("computer help and navigation commands use only the current viewer", async ({
  page,
}, testInfo) => {
  await signup(page, `mobile-controls-${Date.now()}@rakazo.test`, "password12", "Mobile Controls");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Test desktop</title><button id="connect">Connect test viewer</button><script>
    document.getElementById('connect').onclick=()=>parent.postMessage({type:'cadre:computer-navigation-ready'},'*');
    addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='cadre:computer-navigation'){document.body.dataset.action=event.data.action;document.body.dataset.trackpad=String(event.data.enabled)}});
  </script>`,
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: "https://screen.example/vnc.html" } }),
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByTitle("Agent computer").click();
  await page.getByTestId("computer-chrome").waitFor();
  await page.getByRole("button", { name: "Using the computer", exact: true }).click();
  const help = page.getByRole("dialog");
  await expect(
    help.getByRole("heading", { name: "Using the computer", exact: true }),
  ).toBeVisible();
  await expect(
    help.getByText(
      "The keyboard button opens or hides your phone’s keyboard. On a computer, type normally.",
      { exact: true },
    ),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "mobile-computer-gesture-help");
  await page.keyboard.press("Escape");
  await page.getByTestId("computer-more-button").click();
  const trackpad = page.getByRole("menuitemcheckbox", { name: "Trackpad mode", exact: true });
  await expect(trackpad).toBeDisabled();
  await page.evaluate(() => window.postMessage({ type: "cadre:computer-navigation-ready" }, "*"));
  await expect(trackpad).toBeDisabled();
  await page.keyboard.press("Escape");
  const viewer = page.frameLocator('iframe[title="Bot screen"]');
  await viewer.getByRole("button", { name: "Connect test viewer" }).click();
  await page.getByTestId("computer-more-button").click();
  await expect(trackpad).toBeEnabled();
  await trackpad.click();
  await expect(viewer.locator("body")).toHaveAttribute("data-trackpad", "true");
  await expect(page.getByRole("menuitem", { name: "Recenter pointer", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "mobile-computer-trackpad-menu");
  await page.getByRole("menuitem", { name: "Recenter pointer", exact: true }).click();
  await expect(viewer.locator("body")).toHaveAttribute("data-action", "recenter");
});
