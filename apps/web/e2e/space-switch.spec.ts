import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("opening a bot in another space switches in place, without a page reload", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `space-switch-${stamp}@rakazo.test`, "password12", "Space Switcher");
  await completeOnboarding(page);
  const otherSpace = await page.request.post("/rpc/spaces/create", {
    data: { json: { name: "Second space" } },
  });
  const { json: space } = (await otherSpace.json()) as { json: { id: string } };
  const created = await page.request.post("/rpc/bots/create", {
    headers: { "x-rakazo-space-id": space.id },
    data: {
      json: {
        name: "Scout",
        title: "",
        description: "",
        notifyOnFinish: true,
        computerMode: "team",
      },
    },
  });
  expect(created.ok()).toBe(true);
  const { json: scout } = (await created.json()) as { json: { id: string } };
  await page.reload();
  await expect(page.getByRole("button", { name: /Scout/ }).first()).toBeVisible();

  // A reload would drop this marker; an in-place switch keeps it. The observer
  // records any moment the sidebar lost its bots while the screen was not being
  // held by the switch's transition, which is the blank flash people see.
  await page.evaluate(() => {
    const w = window as unknown as { spaceSwitchMarker?: boolean; visibleBlanks?: number };
    w.spaceSwitchMarker = true;
    w.visibleBlanks = 0;
    new MutationObserver(() => {
      const sidebar = document.querySelector('[data-testid="bots-sidebar"]');
      const held = document.documentElement.classList.contains("rk-space-switching");
      if (!sidebar?.textContent?.includes("Scout") && !held) w.visibleBlanks! += 1;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.getByRole("button", { name: /Scout/ }).first().click();
  await page.waitForURL(`**/app/${scout.id}`);
  await expect(page.getByPlaceholder("Message Scout")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { spaceSwitchMarker?: boolean }).spaceSwitchMarker,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as { visibleBlanks?: number }).visibleBlanks),
  ).toBe(0);
  expect(await page.evaluate(() => window.localStorage.getItem("rakazo:space-id"))).toBe(space.id);
  await captureScreenshot(page, testInfo, "space-switch-in-place");
});

test("going back during a slow switch keeps the user where they went", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `space-switch-back-${stamp}@rakazo.test`, "password12", "Space Switcher");
  await completeOnboarding(page);
  const firstBot = new URL(page.url()).pathname;
  const helper = await page.request.post("/rpc/bots/create", {
    data: {
      json: {
        name: "Helper",
        title: "",
        description: "",
        notifyOnFinish: true,
        computerMode: "team",
      },
    },
  });
  const { json: helperBot } = (await helper.json()) as { json: { id: string } };
  const otherSpace = await page.request.post("/rpc/spaces/create", {
    data: { json: { name: "Second space" } },
  });
  const { json: space } = (await otherSpace.json()) as { json: { id: string } };
  await page.request.post("/rpc/bots/create", {
    headers: { "x-rakazo-space-id": space.id },
    data: {
      json: {
        name: "Scout",
        title: "",
        description: "",
        notifyOnFinish: true,
        computerMode: "team",
      },
    },
  });
  await page.reload();
  await page
    .getByRole("button", { name: /Helper/ })
    .first()
    .click();
  await page.waitForURL(`**/app/${helperBot.id}`);
  const homeSpace = await page.evaluate(() => window.localStorage.getItem("rakazo:space-id"));
  expect(homeSpace).not.toBe(space.id);

  // Hold the other space's bootstrap until the user has gone back.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/bootstrap", async (route) => {
    if (route.request().headers()["x-rakazo-space-id"] === space.id) await held;
    await route.continue();
  });
  await page.getByRole("button", { name: /Scout/ }).first().click();
  await page.goBack();
  await page.waitForURL(`**${firstBot}`);
  release();
  await page.waitForTimeout(1_000);
  expect(new URL(page.url()).pathname).toBe(firstBot);
  expect(await page.evaluate(() => window.localStorage.getItem("rakazo:space-id"))).toBe(homeSpace);
});
