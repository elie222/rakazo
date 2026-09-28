import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";

async function openComputer(page: Page) {
  const screenUrl = "https://screen.example/vnc.html";
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test desktop</title><body style='margin:0;background:#3a4a5a'>",
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: screenUrl } }),
    }),
  );
  await page.getByTitle("Agent computer").click();
  const preview = page.getByTestId("computer-preview");
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
}

test("the computer workspace browses, uploads, and downloads files over the screen", async ({
  page,
}, testInfo) => {
  await signup(page, `workspace-${Date.now()}@rakazo.test`, "password12", "Workspace");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  // The intro run may still hold the computer; control is granted once it finishes.
  await expect
    .poll(
      () =>
        rpc(page, "computer/takeover", { botId }).then(
          () => true,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await rpc(page, "computer/uploadFile", {
    botId,
    path: "reports/q3.txt",
    contentBase64: Buffer.from("Q3 draft\n").toString("base64"),
  });
  await openComputer(page);

  await page.getByRole("button", { name: "Files", exact: true }).click();
  const files = page.getByRole("region", { name: "Files" });
  await files.getByRole("button", { name: /^reports/ }).click();
  await expect(files.getByText("~/reports", { exact: true })).toBeVisible();
  await expect(files.getByRole("button", { name: /^q3\.txt/ })).toBeVisible();
  await files.getByRole("button", { name: "Back" }).click();
  await expect(files.getByText("~/", { exact: true })).toBeVisible();
  // Changes made elsewhere (a shell, the bot) appear without reopening the window.
  await rpc(page, "computer/uploadFile", {
    botId,
    path: "made-in-shell.txt",
    contentBase64: Buffer.from("x").toString("base64"),
  });
  await expect(files.getByRole("button", { name: /^made-in-shell\.txt/ })).toBeVisible({
    timeout: 10_000,
  });

  await files.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Quarterly numbers checked.\n"),
  });
  await files.getByRole("button", { name: /^notes\.txt/ }).click();
  await expect(files.getByText("Quarterly numbers checked.")).toBeVisible();
  const download = page.waitForEvent("download");
  await files.getByRole("button", { name: "Download" }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("notes.txt");
  expect(await readFile((await saved.path())!, "utf8")).toBe("Quarterly numbers checked.\n");

  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const terminalWindow = page.getByRole("region", { name: "Terminal" });
  await expect(page.getByTestId("computer-terminal")).toBeVisible();
  // Holding control adds an interactive shell beside the bot's activity. The fake computer
  // answers through the same capability, web proxy, websocket, and frame protocol.
  await terminalWindow.getByRole("tab", { name: "Shell" }).click();
  const shell = page.getByTestId("computer-shell");
  await expect(page.getByTestId("computer-terminal")).toBeHidden();
  await expect(shell).toContainText("$");
  // Click near the pane's corner: the sidebar resize edge currently overlaps the overlay's middle.
  await shell.click({ position: { x: 24, y: 24 } });
  await page.keyboard.type("echo hallo-shell");
  await page.keyboard.press("Enter");
  await expect(shell).toContainText(/\$ echo hallo-shell\s*hallo-shell/);
  await page.keyboard.type("stty size");
  await page.keyboard.press("Enter");
  // The window is narrower than a default 80-column terminal, so this proves resize frames arrive.
  await expect
    .poll(async () => {
      const size = /\$ stty size\s*(\d+) (\d+)/.exec((await shell.textContent()) ?? "");
      return size ? Number(size[2]) : null;
    })
    .toBeLessThan(80);
  await captureScreenshot(page, testInfo, "computer-terminal-shell");

  // The shell stays connected while the Activity tab is shown.
  await terminalWindow.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByTestId("computer-terminal")).toBeVisible();
  await terminalWindow.getByRole("tab", { name: "Shell" }).click();
  await expect(shell).toContainText("hallo-shell");
  // A dropped connection gets a fresh shell instead of a dead pane.
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(shell).toContainText(/\[closed\]\s*\$/);
  await page.keyboard.type("echo wieder-da");
  await page.keyboard.press("Enter");
  await expect(shell).toContainText(/\$ echo wieder-da\s*wieder-da/);
  await terminalWindow.getByRole("tab", { name: "Activity" }).click();
  await captureScreenshot(page, testInfo, "computer-workspace");

  // The browser button tucks the windows away without closing their sessions.
  const browser = page.getByRole("button", { name: "Browser", exact: true });
  await browser.click();
  await expect(browser).toHaveAttribute("aria-pressed", "true");
  await expect(files).toBeHidden();
  await expect(page.getByRole("region", { name: "Terminal" })).toBeHidden();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(files.getByText("Quarterly numbers checked.")).toBeVisible();

  await page.getByRole("button", { name: "Close Files" }).click();
  await expect(files).toBeHidden();

  // Control can end while the computer stays open (released, expired, or handed back for
  // maintenance). "Open shell" then takes control again and goes straight to the shell.
  await rpc(page, "computer/release", { botId });
  await expect(page.getByText("You have control")).toBeHidden();
  await expect(terminalWindow.getByRole("tab", { name: "Shell" })).toHaveCount(0);
  await terminalWindow.getByRole("button", { name: "Open shell" }).click();
  await expect(page.getByText("You have control")).toBeVisible();
  await expect(terminalWindow.getByRole("tab", { name: "Shell" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("computer-shell")).toContainText("$");
});

test("the terminal shows the bot's shell commands and file actions live and after reopening", async ({
  page,
}, testInfo) => {
  await signup(page, `terminal-feed-${Date.now()}@rakazo.test`, "password12", "Terminal Feed");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await openComputer(page);

  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const terminal = page.getByTestId("computer-terminal");
  await expect(terminal).toBeVisible();
  // Poll the send: the intro run may still be finishing when the test starts.
  await expect
    .poll(
      () =>
        rpc(page, "threads/send", {
          botId,
          text: "run the shell command echo terminal-feed-ok",
        }).then(
          () => true,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(terminal).toContainText("$ echo terminal-feed-ok", { timeout: 30_000 });
  await expect(terminal).toContainText(/terminal-feed-ok\s*$/m);
  // A command's running and done events render as one entry.
  await expect
    .poll(async () => ((await terminal.textContent()) ?? "").split("$ echo").length - 1)
    .toBe(1);
  // The shell line is live before that run finishes. Sending now would queue
  // steering, and the scripted continuation would not run the file request.
  await expect
    .poll(
      async () =>
        (await rpc<{ run: { status: string } | null }>(page, "threads/get", { botId })).run
          ?.status ?? "idle",
      { timeout: realSandboxTimeout(90_000, 30_000) },
    )
    .toBe("idle");
  // File tools show up too, not only shell commands.
  await expect
    .poll(
      () =>
        rpc(page, "threads/send", {
          botId,
          text: "write a file called feed-note.txt that says hallo",
        }).then(
          () => true,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(terminal).toContainText("Wrote feed-note.txt", { timeout: 30_000 });
  await captureScreenshot(page, testInfo, "computer-terminal-bot-feed");

  await page.getByRole("button", { name: "Close Terminal" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByTestId("computer-terminal")).toContainText("$ echo terminal-feed-ok");
  await expect(page.getByTestId("computer-terminal")).toContainText("Wrote feed-note.txt");
});
