import { expect, type Page, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test("two users are isolated and a bot completes durable work", async ({ browser }, testInfo) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();

  const stamp = Date.now();
  await signup(pageA, `ada-${stamp}@rakazo.test`, "password12", "Ada", testInfo);
  await completeOnboarding(pageA, testInfo);
  await expect(pageA.getByText("Chief").first()).toBeVisible();

  await signup(pageB, `bob-${stamp}@rakazo.test`, "password12", "Bob");
  await completeOnboarding(pageB);
  await expect(pageB.getByText("Chief").first()).toBeVisible();
  await expect(pageB.getByText("Ada", { exact: true })).toHaveCount(0);

  const composer = pageA.getByPlaceholder(/Message/);
  await composer.fill("write a file in your home called notes/result.txt that says isolation-ok");
  await pageA.keyboard.press("Enter");
  await expect(
    pageA.getByText(/writing that into my home|isolation-ok|handled/i).first(),
  ).toBeVisible({
    timeout: 30_000,
  });

  await pageA.reload();
  await expect(pageA.getByText(/isolation-ok|writing that into my home/i).first()).toBeVisible();
  await captureScreenshot(pageA, testInfo, "07-durable-bot-work");

  await a.close();
  await b.close();
});

test("takeover, routine, plugins, and export are reachable", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `flow-${stamp}@rakazo.test`, "password12", "Flow");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("install the gsc cli and sign in");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/sign in to continue|protected input/i).first()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  await expect
    .poll(() => threadRunStatus(page), {
      timeout: realSandboxTimeout(90_000, 30_000),
      message: "the protected-input run must be ready for takeover",
    })
    .toBe("waiting_takeover");
  await captureScreenshot(page, testInfo, "08-protected-input-request");
  await page.getByTitle("Agent computer").click();
  const sidePanel = page.getByTestId("side-panel");
  await expect(sidePanel).toHaveCSS("width", "384px");
  const [mainBox, panelBox] = await Promise.all([
    page.locator("main").boundingBox(),
    sidePanel.boundingBox(),
  ]);
  expect(mainBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect((mainBox?.x ?? 0) + (mainBox?.width ?? 0)).toBeLessThanOrEqual(panelBox?.x ?? 0);
  await page.getByRole("button", { name: "Take control" }).click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip", exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "I’m done", exact: true }).last()).toBeVisible();
  if (process.env.SANDBOX_PROVIDER === "box") await waitForBoxFramebuffer(page);
  await captureScreenshot(page, testInfo, "09-computer-takeover-outcomes");
  await page.getByRole("button", { name: "I’m done", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeHidden();
  await expect(page.getByText(/signed in|session stays/i).first()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });

  await composer.fill("sign in again so I can skip this time");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => threadRunStatus(page), {
      timeout: realSandboxTimeout(90_000, 30_000),
      message: "the second protected-input run must be ready for takeover",
    })
    .toBe("waiting_takeover");
  await page.getByRole("button", { name: "Take control" }).click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeHidden();
  await expect(page.getByText(/login was skipped/i).last()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  await captureScreenshot(page, testInfo, "09a-computer-takeover-skipped");

  await page.getByText("+ New routine").click();
  await page.locator("label:has-text('Name') input").fill("Monday briefing");
  await page
    .locator("label:has-text('Instruction') textarea")
    .fill("write a file in your home called notes/result.txt that says routine-ok");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Monday briefing")).toBeVisible();
  await captureScreenshot(page, testInfo, "10-routine-created");

  await page.getByText("Integrations").click();
  await expect(page.getByPlaceholder("Search apps")).toBeVisible();
  await expect(page.getByText("Gmail", { exact: true })).toBeVisible();
  await expect(page.getByText("Slack", { exact: true })).toBeVisible();
  await expect(page.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(page.getByText("Notion", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "11-plugins-catalog");

  const gmailRow = page.getByText("Gmail", { exact: true }).locator("..").locator("..");
  await gmailRow.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(gmailRow.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Connected", exact: true }).click();
  await expect(page.getByText("Slack", { exact: true })).toBeHidden();
  await captureScreenshot(page, testInfo, "11a-connected-plugins");

  await gmailRow.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByText("No connected apps yet.", { exact: true })).toBeVisible();
  await expect(page.getByText("Gmail", { exact: true })).toBeHidden();
  await captureScreenshot(page, testInfo, "11b-connected-plugins-empty");

  await page.getByRole("tab", { name: "Apps", exact: true }).click();
  await expect(page.getByText("Gmail", { exact: true })).toBeVisible();
  await expect(gmailRow.getByRole("button", { name: "Connect", exact: true })).toBeVisible();

  const linearRow = page.getByText("Linear", { exact: true }).locator("..").locator("..");
  const connectPopup = page.waitForEvent("popup");
  await linearRow.getByRole("button", { name: "Connect", exact: true }).click();
  const popup = await connectPopup;
  await popup.close();
  await expect(linearRow.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
  await linearRow.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(linearRow.getByRole("button", { name: "Connect", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add Treg", exact: true }).click();
  await page.getByPlaceholder("Treg token").fill("fake-treg-browser-credential");
  await page.getByRole("button", { name: "Verify and add", exact: true }).click();
  await expect(page.getByText(/MCP · https:\/\/treg\.to\/mcp\/ · credential saved/)).toBeVisible();

  await page.getByRole("button", { name: "Add MCP server", exact: true }).click();
  await page.getByPlaceholder("Display name").fill("Browser MCP");
  await page.getByPlaceholder("https://example.com/mcp").fill("https://mcp.example.test/mcp");
  await page.getByRole("button", { name: "Verify and add", exact: true }).click();
  await expect(page.getByText(/MCP · https:\/\/mcp\.example\.test\/mcp · no auth/)).toBeVisible();

  await page.getByRole("button", { name: "Add OpenAPI", exact: true }).click();
  await page.getByPlaceholder("Display name").fill("Browser API");
  await page
    .getByPlaceholder("https://example.com/openapi.json")
    .fill("https://api.example.test/openapi.json");
  await page.locator("select").selectOption("bearer");
  await page.getByPlaceholder("Credential").fill("fake-openapi-browser-credential");
  await page.getByRole("button", { name: "Verify and add", exact: true }).click();
  await expect(
    page.getByText(/API · https:\/\/api\.example\.test\/v1 · credential saved/),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "11c-provider-emulators");

  await page.getByRole("button", { name: "Close integrations" }).click();

  await page.getByText("Chief").first().click();
  const gear = page.getByRole("button", { name: "Show settings" });
  if (!(await gear.isVisible().catch(() => false))) {
    await page.getByTitle("Agent computer").click();
  }
  await gear.click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/chief-export\.json/i);
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByRole("button", { name: "Archive bot" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Delete bot" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close panel" }).click();

  await page.locator("aside").first().getByRole("button", { name: /Chief/ }).first().click({
    button: "right",
  });
  const botMenu = page.getByRole("menu", { name: "Actions for Chief" });
  await expect(botMenu.getByRole("menuitem", { name: "Archive" })).toBeVisible();
  await botMenu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("radio", { name: /Keep memories/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /Delete memories too/ })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await captureScreenshot(page, testInfo, "12-bot-settings");
});

test("sign-in, spawn, and stop work in the shell", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const email = `shell-${stamp}@rakazo.test`;
  await signup(page, email, "password12", "Shell");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("spawn a bot named Scout to research venues");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary").getByRole("button", { name: /Scout/ })).toBeVisible({
    timeout: 30_000,
  });
  await captureScreenshot(page, testInfo, "13-spawned-bot");

  await page
    .getByRole("complementary")
    .getByRole("button", { name: /^Chief/ })
    .click();
  await composer.fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  await expect(page.getByText("still working").first()).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "14-active-bot-work");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });

  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill("password12");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await expect(
    page.getByRole("complementary").getByRole("button", { name: /^Chief/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary").getByRole("button", { name: /Scout/ }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "15-restored-session");
});

test("bot context menu pins, duplicates, edits, and confirms deletion", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `menu-${stamp}@rakazo.test`, "password12", "Menu");
  await completeOnboarding(page);

  const chief = page.getByRole("button", { name: /Chief/ }).first();
  await chief.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Actions for Chief" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Edit Profile" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await captureScreenshot(page, testInfo, "16-bot-context-menu");
  await page.getByRole("menuitem", { name: "Mark as Unread" }).click();

  // Chief is the open bot, so the auto-read on window focus must not undo the manual mark.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await chief.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Mark as Read" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Mark as Read" }).click();

  await chief.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();

  await chief.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Unpin", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByText("Chief copy").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "17-pinned-and-duplicated-bot");

  const copy = page.getByRole("button", { name: /Chief copy/ }).first();
  await copy.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete Chief copy?" })).toBeVisible();
  await captureScreenshot(page, testInfo, "18-delete-confirmation");
  await page.getByRole("button", { name: "Cancel" }).click();

  await chief.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit Profile" }).click();
  await expect(page.locator("label:has-text('Name') input")).toHaveValue("Chief");
  await captureScreenshot(page, testInfo, "19-edit-profile");
});

async function threadRunStatus(page: Page) {
  const result = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", {
    botId: activeBotId(page),
  });
  return result.run?.status ?? "idle";
}

async function waitForBoxFramebuffer(page: Page) {
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const canvas = frame.locator("canvas").first();
          if ((await canvas.count()) === 0) continue;
          const ready = await canvas
            .evaluate((element) => {
              const framebuffer = element as HTMLCanvasElement;
              return framebuffer.width > 0 && framebuffer.height > 0;
            })
            .catch(() => false);
          if (ready) return true;
        }
        return false;
      },
      { timeout: 60_000, message: "the Box noVNC framebuffer must be ready" },
    )
    .toBe(true);
}
