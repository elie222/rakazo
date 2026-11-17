import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

type OrganizationList = {
  organizations: Array<{ id: string; name: string; defaultSpaceId: string }>;
};

test.afterEach(async ({ page }) => {
  // Not "wait": a handler whose fulfill() lost a race to the route teardown never settles,
  // and "wait" would then hang the test to its timeout.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

function selectedSpace(page: Page) {
  return page.evaluate(() => window.localStorage.getItem("rakazo:space-id"));
}

async function openAvatarMenu(page: Page) {
  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect(menu.getByRole("button", { name: "Settings" })).toBeVisible();
  return menu;
}

/** Closes the avatar menu and its submenu together; Escape would close only the submenu. */
async function closeAvatarMenu(page: Page) {
  await page.getByTestId("user-menu-trigger").click();
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
}

/** Opens the avatar menu's organization submenu, which lists them and starts a new one. */
async function openOrganizationMenu(page: Page) {
  await openAvatarMenu(page);
  await page.getByTestId("organization-menu-trigger").click();
  const submenu = page.locator('[data-slot="popover-content"]').last();
  await expect(submenu.getByRole("button", { name: "New organization" })).toBeVisible();
  return submenu;
}

/** Resolves once a chat other than `leaving` is open, outside settings. */
function chatOpened(page: Page, leaving: string) {
  return page.waitForURL(
    (url) =>
      /^\/app\/[^/]+$/.test(url.pathname) &&
      url.pathname !== leaving &&
      !url.searchParams.has("settings"),
  );
}

async function switchFromAvatarMenu(page: Page, name: string, spaceId: string) {
  const leaving = new URL(page.url()).pathname;
  const menu = await openOrganizationMenu(page);
  await menu.getByRole("button", { name, exact: true }).click();
  await chatOpened(page, leaving);
  expect(await selectedSpace(page)).toBe(spaceId);
}

test("create, switch, rename and delete an organization", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `organizations-${stamp}@rakazo.test`, "password12", "Org Owner");
  await completeOnboarding(page);

  // One organization: settings show only its name and its members, and the avatar menu names it
  // and opens a submenu that lists it and starts a new one.
  let settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-organization").click();
  const single = settings.getByTestId("organization-settings");
  await expect(single.getByLabel("Name")).toHaveValue("Personal");
  await expect(single.getByRole("button")).toHaveText([/^Members/]);
  await captureScreenshot(page, testInfo, "org-settings-single");
  await page.keyboard.press("Escape");

  let menu = await openOrganizationMenu(page);
  await expect(menu.getByRole("button", { name: "Personal", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await captureScreenshot(page, testInfo, "org-menu-single");
  await menu.getByRole("button", { name: "New organization" }).click();
  const create = page.getByRole("dialog", { name: "Create organization" });
  await create.getByLabel("Name").fill("Work");
  await captureScreenshot(page, testInfo, "org-create-dialog");

  // Hold the new organization on onboarding's model step so its account menu can be seen.
  // The rewrites are tracked so they can be finished before interception stops: waiting on
  // Playwright's own bookkeeping can hang when a fulfill() loses a race to the teardown.
  let holdModelStep = true;
  const rewrites = new Set<Promise<void>>();
  await page.route("**/rpc/me", (route) => {
    if (!holdModelStep) return route.fallback();
    const rewrite = (async () => {
      try {
        const response = await route.fetch();
        const body = (await response.json()) as { json: Record<string, unknown> };
        await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
      } catch {
        await route.abort().catch(() => {});
      }
    })();
    rewrites.add(rewrite);
    return rewrite.finally(() => rewrites.delete(rewrite));
  });
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/onboarding/);
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();

  const { organizations } = await rpc<OrganizationList>(page, "organizations/list", {});
  const personal = organizations.find((organization) => organization.name === "Personal")!;
  const work = organizations.find((organization) => organization.name === "Work")!;
  expect(organizations).toHaveLength(2);
  expect(await selectedSpace(page)).toBe(work.defaultSpaceId);

  await page.getByTestId("account-menu").click();
  await expect(page.getByRole("menuitemradio", { name: "Work" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("menuitemradio", { name: "Personal" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await captureScreenshot(page, testInfo, "org-account-menu-onboarding");
  holdModelStep = false;
  await Promise.all([...rewrites]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.getByRole("menuitemradio", { name: "Personal" }).click();
  await chatOpened(page, "");
  expect(await selectedSpace(page)).toBe(personal.defaultSpaceId);

  // Two organizations: both are listed, the active one checked.
  menu = await openOrganizationMenu(page);
  await expect(menu.getByRole("button", { name: "Personal", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(menu.getByRole("button", { name: "Work", exact: true })).not.toHaveAttribute(
    "aria-current",
    "true",
  );
  await captureScreenshot(page, testInfo, "org-menu-two-orgs");
  await closeAvatarMenu(page);

  // Work has no bot yet, so its first visit finishes onboarding there.
  await switchFromAvatarMenu(page, "Work", work.defaultSpaceId);
  const workChat = new URL(page.url()).pathname;
  await switchFromAvatarMenu(page, "Personal", personal.defaultSpaceId);

  // A link to a chat in another organization opens it there.
  await page.goto(workChat);
  await expect.poll(() => selectedSpace(page)).toBe(work.defaultSpaceId);
  await expect(page).toHaveURL((url) => url.pathname === workChat);

  // So does a link to a group chat there.
  const inWork = async <T>(procedure: string, json: unknown) => {
    const response = await page.request.post(`/rpc/${procedure}`, {
      headers: { "x-rakazo-space-id": work.defaultSpaceId },
      data: { json },
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { json: T }).json;
  };
  const scout = await inWork<{ id: string }>("bots/create", {
    name: "Scout",
    computerMode: "team",
  });
  const standup = await inWork<{ id: string }>("groups/create", {
    name: "Standup",
    botIds: [workChat.split("/")[2], scout.id],
  });
  await switchFromAvatarMenu(page, "Personal", personal.defaultSpaceId);
  await page.goto(`/app/g/${standup.id}`);
  await expect.poll(() => selectedSpace(page)).toBe(work.defaultSpaceId);
  await expect(page).toHaveURL((url) => url.pathname === `/app/g/${standup.id}`);

  settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-organization").click();
  const organization = settings.getByTestId("organization-settings");
  const name = organization.getByLabel("Name");
  await expect(name).toHaveValue("Work");
  await captureScreenshot(page, testInfo, "org-settings");
  await name.fill("Acme");
  await name.press("Enter");
  await expect
    .poll(async () =>
      (await rpc<OrganizationList>(page, "organizations/list", {})).organizations.map(
        (item) => item.name,
      ),
    )
    .toEqual(["Personal", "Acme"]);

  await organization.getByRole("button", { name: "Delete organization" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete Acme?" });
  const remove = confirm.getByRole("button", { name: "Delete", exact: true });
  await expect(remove).toBeDisabled();
  await confirm.getByLabel("Type Acme to confirm").fill("acme");
  await expect(remove).toBeDisabled();
  await confirm.getByLabel("Type Acme to confirm").fill("Acme");
  await expect(remove).toBeEnabled();
  await captureScreenshot(page, testInfo, "org-delete-confirm");
  const leaving = new URL(page.url()).pathname;
  await remove.click();
  await chatOpened(page, leaving);
  expect(await selectedSpace(page)).toBe(personal.defaultSpaceId);

  menu = await openOrganizationMenu(page);
  await expect(menu.getByRole("button", { name: "Acme", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: "Personal", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
});
