import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function captureSidebarSearchSelected(
  page: Page,
  testInfo: Parameters<typeof captureScreenshot>[1],
  name: string,
) {
  const aside = page.locator("aside").first();
  const search = aside.getByTestId("sidebar-search");
  const selected = aside.getByRole("button", { name: /^Chief/ }).first();
  await expect(search).toBeVisible();
  await expect(selected).toBeVisible();
  await search.scrollIntoViewIfNeeded();

  const searchBox = await search.boundingBox();
  const selectedBox = await selected.boundingBox();
  expect(searchBox).toBeTruthy();
  expect(selectedBox).toBeTruthy();
  if (searchBox && selectedBox) {
    expect(Math.abs(searchBox.x - selectedBox.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(searchBox.x + searchBox.width - (selectedBox.x + selectedBox.width)),
    ).toBeLessThanOrEqual(1);
  }

  const box = await aside.boundingBox();
  if (box) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      path: screenshotPath,
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.min(box.width + 24, 360),
        height: Math.min(Math.max(box.height * 0.45, 280), 420),
      },
    });
    await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
    return;
  }
  await captureScreenshot(page, testInfo, name);
}

test("account settings appearance control switches to light mode", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-appearance-${stamp}@rakazo.test`, "password12", "Appearance QA");
  await completeOnboarding(page, testInfo);

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-appearance-select");
  await expect(picker).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-appearance-control");

  await settings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureScreenshot(page, testInfo, "ui-appearance-dark-settings");

  await settings.getByTestId("ui-appearance-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(settings.getByTestId("ui-appearance-light")).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "ui-appearance-light-settings");

  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await captureScreenshot(page, testInfo, "ui-appearance-light-shell");
  await captureSidebarSearchSelected(page, testInfo, "sidebar-search-selected-light");

  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("Please review `shared/PROJECT_CHECKPOINT_WRAPUP.md`.");
  await composer.press("Enter");
  const assistantReply = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ hasText: "done. i handled:" });
  const inlinePath = assistantReply
    .locator("code")
    .filter({ hasText: "shared/PROJECT_CHECKPOINT_WRAPUP.md" });
  await expect(inlinePath).toBeVisible({ timeout: 30_000 });
  await expect(inlinePath).toHaveCSS("color", "rgb(0, 0, 0)");
  await captureScreenshot(page, testInfo, "inline-code-light");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureSidebarSearchSelected(page, testInfo, "sidebar-search-selected-dark");
});

test("sidebar footer opens integrations and the account menu", async ({ page }, testInfo) => {
  await signup(page, `footer-web-${Date.now()}@rakazo.test`, "password12", "Footer Demo");
  await completeOnboarding(page);
  const footer = page.getByTestId("sidebar-footer");
  await expect(footer).toBeVisible();
  const searchBox = await page.getByTestId("sidebar-search").boundingBox();
  const avatarBox = await page.getByTestId("user-menu-trigger").boundingBox();
  const pillBox = await footer
    .getByRole("button", { name: "Connect apps", exact: true })
    .boundingBox();
  expect(searchBox).toBeTruthy();
  expect(avatarBox).toBeTruthy();
  expect(pillBox).toBeTruthy();
  if (searchBox && avatarBox && pillBox) {
    expect(avatarBox.x).toBe(searchBox.x);
    expect(pillBox.x + pillBox.width).toBe(searchBox.x + searchBox.width);
    expect(pillBox.height).toBe(avatarBox.height);
  }
  await expect(footer.getByRole("button", { name: "Install update", exact: true })).toHaveCount(0);
  await footer.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close integrations", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();
  await page.getByTestId("user-menu-trigger").click();
  await expect(page.getByRole("link", { name: "Get the mobile app", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Docs", exact: true })).toBeVisible();
  await expect(footer.locator('span[aria-hidden="true"] > span')).toHaveCount(3);
  if (avatarBox && pillBox) {
    await expect
      .poll(async () => {
        const menuBox = await page.locator('[data-slot="popover-content"]').boundingBox();
        return (
          menuBox && {
            x: menuBox.x,
            width: menuBox.width,
            gap: avatarBox.y - menuBox.y - menuBox.height,
          }
        );
      })
      .toEqual({ x: avatarBox.x, width: pillBox.x + pillBox.width - avatarBox.x, gap: 8 });
  }
  await captureScreenshot(page, testInfo, "sidebar-footer-menu");
  await page.keyboard.press("Escape");
  await page.getByTestId("minimize-bots-sidebar").click();
  await expect(footer).toBeInViewport();
  await expect(page.getByTestId("bots-sidebar")).toHaveCSS("width", "72px");
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible();
  await page.getByTestId("restore-bots-sidebar").click();
  await expect(footer).toBeInViewport();
});

test("sidebar footer keeps the account identity readable and installs a ready desktop update", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const state = {
      phase: "ready",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      percent: 100,
      message: null,
      checkedAt: null,
    };
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "darwin",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
        update: {
          state: async () => state,
          check: async () => state,
          download: async () => state,
          install: async () => {
            document.documentElement.dataset.updateInstalled = String(
              Number(document.documentElement.dataset.updateInstalled ?? 0) + 1,
            );
            return state;
          },
        },
      },
    });
  });
  const email = `footer-${Date.now()}@rakazo.test`;
  await signup(page, email, "password12", "Footer Demo");
  await completeOnboarding(page);
  await page.request.post("/api/auth/update-user", { data: { name: "Footer Demo" } });
  await page.reload();
  const footer = page.getByTestId("sidebar-footer");
  const avatar = page.getByTestId("user-menu-trigger");
  const session = await (await page.request.get("/api/auth/get-session")).json();
  await expect(avatar).toHaveAccessibleName(`Account menu for ${session.user.name}`);
  await expect(footer.getByRole("button", { name: "Install update", exact: true })).toBeVisible();
  // Dismiss the existing update toast so the two footer frames stay focused.
  await page
    .getByRole("complementary", { name: "Desktop update" })
    .getByRole("button", { name: "Later" })
    .click();
  await avatar.click();
  const header = page.getByTestId("account-menu-header");
  await expect(header).toHaveText(`${session.user.name}${email}`);
  await expect(page.getByText("New update available", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
  await expect(footer.locator('span[aria-hidden="true"] > span')).toHaveCount(3);
  await captureScreenshot(page, testInfo, "sidebar-footer-menu-update");
  await page.keyboard.press("Escape");
  await footer.getByRole("button", { name: "Install update", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-update-installed", "1");

  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(avatar).toBeInViewport();
  // Font metrics can change the count at this viewport; exact bands are covered below.
  await expect(footer.locator('span[aria-hidden="true"] > span:visible').first()).toBeVisible();
  const pill = footer.getByRole("button", { name: "Connect apps", exact: true });
  const label = pill.locator("span").first();
  expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const controls = [
    avatar,
    pill,
    footer.getByRole("button", { name: "Install update", exact: true }),
  ];
  const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
  expect(boxes.every((box) => box?.height === 36 && box.y === boxes[0]?.y)).toBe(true);
  expect(await footer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const updateButton = controls[2]!;
  await updateButton.click();
  expect(await updateButton.evaluate((el) => el.matches(":focus-visible"))).toBe(false);
  await avatar.click();
  await avatar.click();
  expect(await avatar.evaluate((el) => el.matches(":focus-visible"))).toBe(false);
  await updateButton.focus();
  expect(await updateButton.evaluate((el) => el.matches(":focus-visible"))).toBe(false);
  await page.keyboard.press("Tab");
  await updateButton.focus();
  expect(await updateButton.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  await updateButton.evaluate((el) => el.blur());

  // Width changes must drop marks before taking space from the label or padding.
  // Measure the fixed controls and label, then target the middle of each band.
  // Marks need 26px initially and 22px per additional mark, leaving 11px margin.
  const fixedWidth = await pill.evaluate((el) => {
    const style = getComputedStyle(el);
    return (
      el.parentElement!.getBoundingClientRect().width -
      el.clientWidth +
      Number.parseFloat(style.paddingLeft) +
      Number.parseFloat(style.paddingRight) +
      el.querySelector("span")!.scrollWidth +
      Number.parseFloat(style.columnGap)
    );
  });
  for (const [availableWidth, count] of [
    [17, 0],
    [37, 1],
    [59, 2],
    [81, 3],
  ]) {
    const width = fixedWidth + availableWidth!;
    await footer.evaluate((el, width) => {
      el.style.width = `${width}px`;
    }, width);
    const marks = footer.locator('span[aria-hidden="true"] > span');
    await expect(marks).toHaveCount(count!);
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (count) {
      const rightInset = await pill.evaluate((el) => {
        const marks = el.querySelector('span[aria-hidden="true"]')!;
        return el.getBoundingClientRect().right - marks.getBoundingClientRect().right;
      });
      expect(rightInset).toBeGreaterThanOrEqual(11);
    }
  }
  await footer.evaluate((el) => el.style.removeProperty("width"));
  // A translation wider than the pill must still leave room for the update control.
  await label.evaluate((el) => {
    el.textContent = "Connecter des applications";
  });
  await expect(footer.locator('span[aria-hidden="true"] > span')).toHaveCount(0);
  const translatedPill = footer.getByRole("button", {
    name: "Connecter des applications",
    exact: true,
  });
  const translatedLabel = translatedPill.locator("span").first();
  expect(await translatedLabel.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(translatedLabel).toHaveCSS("text-overflow", "ellipsis");
  const labelBox = await translatedLabel.boundingBox();
  const pillBox = await translatedPill.boundingBox();
  expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(pillBox!.x + pillBox!.width - 11);
  expect(await footer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 740, height: 320 });
  await avatar.click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect
    .poll(async () => {
      const box = await menu.boundingBox();
      return box && box.y >= 0 && box.y + box.height <= 320;
    })
    .toBe(true);
  await expect(header).toBeInViewport();
  await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
  const logOut = menu.getByRole("button", { name: "Log out", exact: true });
  await logOut.scrollIntoViewIfNeeded();
  await expect(logOut).toBeInViewport();
  expect((await logOut.boundingBox())!.height).toBe(36);
  await captureScreenshot(page, testInfo, "sidebar-footer-short-screen");
  await menu.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("user-settings")).toBeVisible();
});

test("footer app marks follow the integrations overlay", async ({ page }) => {
  await signup(page, `footer-apps-${Date.now()}@rakazo.test`, "password12", "Footer Demo");
  await completeOnboarding(page);
  let connected = true;
  let listed = true;
  let failCatalog = false;
  let failConnections = false;
  const logo =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ctext x='5' y='15'%3ES%3C/text%3E%3C/svg%3E";
  await page.route("**/rpc/connections/list", async (route) => {
    if (failConnections) {
      await route.fulfill({ status: 503, json: { message: "Demo connections unavailable" } });
      return;
    }
    await route.continue();
  });
  await page.route("**/rpc/connections/catalog", async (route) => {
    if (failCatalog) {
      await route.fulfill({ status: 503, json: { message: "Demo catalog unavailable" } });
      return;
    }
    await route.fulfill({
      json: {
        json:
          listed && !failConnections
            ? [
                {
                  connectorId: "demo",
                  slug: "slack",
                  name: "Slack",
                  logo,
                  connected,
                  noAuth: false,
                },
              ]
            : [],
      },
    });
  });
  const footer = page.getByTestId("sidebar-footer");
  await footer.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expect(footer.locator("img")).toHaveAttribute("src", logo);
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();
  await expect(footer.locator("img")).toHaveAttribute("src", logo);
  failCatalog = true;
  await footer.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expect(page.getByText("Could not reach the server", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();
  await expect(footer.locator("img")).toHaveAttribute("src", logo);
  failCatalog = false;
  connected = false;
  await footer.getByRole("button", { name: "Connect apps", exact: true }).click();
  // Disconnected catalog entries remain available as suggestions.
  await expect(footer.locator("img")).toHaveAttribute("src", logo);
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();
  await expect(footer.getByRole("button", { name: "Connect apps", exact: true })).toBeVisible();
  failCatalog = true;
  const failedRefresh = page.waitForResponse(
    (response) => response.url().includes("connections/catalog") && response.status() === 503,
  );
  await page
    .getByRole("button", { name: /^Chief/ })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Chief copy/ }).first()).toBeVisible();
  await failedRefresh;
  await expect(footer.locator("img")).toHaveAttribute("src", logo);
  failCatalog = false;
  failConnections = true;
  const failedConnections = page.waitForResponse(
    (response) => response.url().includes("connections/list") && response.status() === 503,
  );
  await page
    .getByRole("button", { name: /^Chief copy/ })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Chief copy copy/ }).first()).toBeVisible();
  await failedConnections;
  await expect(footer.locator("img")).toHaveAttribute("src", logo);
  failConnections = false;
  for (const name of [/^Chief copy copy/, /^Chief copy/, /^Chief/]) {
    const bot = page.getByRole("button", { name }).first();
    await bot.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expect(bot).toBeHidden();
  }
  await page.reload();
  await expect(footer.locator("img")).toHaveAttribute("src", logo);
  listed = false;
  await footer.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expect(footer.locator("img")).toHaveCount(0);
});

test("sidebar list fades above the transparent footer and keeps the last row reachable", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signup(page, `footer-scroll-${Date.now()}@rakazo.test`, "password12", "Demo User");
  await completeOnboarding(page);
  for (let index = 0; index < 20; index++) {
    await rpc(page, "bots/create", {
      name: `Demo chat ${index}`,
      title: "",
      description: "",
      notifyOnFinish: true,
      computerMode: "team",
    });
  }
  await page.reload();
  const sidebar = page.getByTestId("bots-sidebar");
  const footer = page.getByTestId("sidebar-footer");
  const list = sidebar.locator(".rk-scroll").first();
  const lastRow = list.getByRole("button", { name: /^Demo chat 19/ }).first();
  await expect(lastRow).toHaveCount(1);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => localStorage.setItem("rakazo.uiAppearance", theme), theme);
    await page.reload();
    await expect(lastRow).toHaveCount(1);
    await expect(footer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(footer).toHaveCSS("background-image", "none");
    await list.evaluate((el) => (el.scrollTop = (el.scrollHeight - el.clientHeight) / 2));
    await expect
      .poll(() =>
        list.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--scroll-fade-b"))),
      )
      .toBeGreaterThan(20);
    const listBox = await list.boundingBox();
    const avatarBox = await page.getByTestId("user-menu-trigger").boundingBox();
    expect(listBox!.y + listBox!.height).toBeLessThan(avatarBox!.y);
    // Disabling animations fast-forwards the scroll timeline and removes its fade.
    const screenshotPath = testInfo.outputPath(`sidebar-footer-scrolled-${theme}.png`);
    await page.screenshot({ path: screenshotPath, animations: "allow" });
    await testInfo.attach(`sidebar-footer-scrolled-${theme}`, {
      contentType: "image/png",
      path: screenshotPath,
    });
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect
      .poll(() =>
        list.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--scroll-fade-b"))),
      )
      .toBe(0);
    await lastRow.focus();
    await expect(lastRow).toBeFocused();
    await expect(lastRow).toBeInViewport();
    const rowBox = await lastRow.boundingBox();
    expect(rowBox!.y + rowBox!.height).toBeLessThan(avatarBox!.y);
  }
});
