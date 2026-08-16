import { expect, type Page, test } from "@playwright/test";

test("Team Computer gives bots a home folder plus shared space while Private stays isolated", async ({
  page,
}) => {
  const stamp = Date.now();
  const personalMarker = `personal-${stamp}`;
  const sharedMarker = `shared-${stamp}`;
  const privateMarker = `private-${stamp}`;

  await signup(page, `team-computer-${stamp}@rakazo.test`, "Team Computer");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);

  await openComputerPanel(page);
  await expect(page.getByText("Team Computer", { exact: true }).last()).toBeVisible();

  const writerId = await createBot(page, "Writer", "team");
  await sendAndWait(
    page,
    writerId,
    `write a file in your home called notes/result.txt that says ${personalMarker}`,
  );

  await expect(readFile(page, writerId, "notes/result.txt")).resolves.toContain(personalMarker);
  await expect(readFileResponse(page, chiefId, "notes/result.txt")).resolves.toMatchObject({
    ok: false,
  });
  await expect(readFile(page, chiefId, `bots/${writerId}/notes/result.txt`)).resolves.toContain(
    personalMarker,
  );

  await sendAndWait(
    page,
    writerId,
    `write a file called shared/notes/result.txt that says ${sharedMarker}`,
  );
  await expect(readFile(page, chiefId, "shared/notes/result.txt")).resolves.toContain(sharedMarker);

  const privateId = await createBot(page, "Private Writer", "dedicated");
  await openComputerPanel(page);
  await expect(page.getByText("Private Writer’s computer", { exact: true }).last()).toBeVisible();
  await expect(readFileResponse(page, privateId, "notes/result.txt")).resolves.toMatchObject({
    ok: false,
  });

  await sendAndWait(
    page,
    privateId,
    `write a file in your home called notes/result.txt that says ${privateMarker}`,
  );
  await expect(readFileResponse(page, chiefId, "notes/result.txt")).resolves.toMatchObject({
    ok: false,
  });

  await setComputerMode(page, "Private Writer", privateId, "team");
  await expect(readFileResponse(page, privateId, "notes/result.txt")).resolves.toMatchObject({
    ok: false,
  });
  await expect(readFile(page, privateId, "shared/notes/result.txt")).resolves.toContain(
    sharedMarker,
  );

  await setComputerMode(page, "Private Writer", privateId, "dedicated");
  await expect(readFile(page, privateId, "notes/result.txt")).resolves.toContain(privateMarker);
  await expect(readFile(page, writerId, "notes/result.txt")).resolves.toContain(personalMarker);
});

test("user control blocks another Team bot until the computer is released", async ({ page }) => {
  const stamp = Date.now();
  const marker = `after-release-${stamp}`;

  await signup(page, `team-control-${stamp}@rakazo.test`, "Team Control");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const workerId = await createBot(page, "Worker", "team");

  await openBot(page, "Chief");
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await page.getByRole("button", { name: "Close computer" }).click();

  await openBot(page, "Worker");
  await sendMessage(page, `write a file in your home called notes/result.txt that says ${marker}`);

  await expect
    .poll(async () => (await threadSnapshot(page, workerId)).run?.status ?? "idle", {
      timeout: 5_000,
      intervals: [250, 500, 1_000],
      message: "the worker must remain queued while the user controls the Team Computer",
    })
    .toBe("queued");
  // Keep control through multiple executor retry windows and prove no tool side effect occurs.
  await page.waitForTimeout(1_500);
  await expect(
    rpc<{ controlHolder: string }>(page, "computer/status", { botId: workerId }),
  ).resolves.toMatchObject({ controlHolder: "user" });
  await expect(readFileResponse(page, workerId, "notes/result.txt")).resolves.toMatchObject({
    ok: false,
  });

  const release = page.getByRole("button", { name: "Release", exact: true });
  if (!(await release.isVisible().catch(() => false))) {
    await page.getByTitle("Agent computer").click();
  }
  await expect(release).toBeVisible();
  await expect(page.getByText("You have control", { exact: true })).toBeVisible();
  await release.click();

  await waitForRun(page, workerId);
  await expect(readFile(page, workerId, "notes/result.txt")).resolves.toContain(marker);
  await expect(readFileResponse(page, chiefId, "notes/result.txt")).resolves.toMatchObject({
    ok: false,
  });
});

test("an active Team bot must be stopped before user takeover", async ({ page }) => {
  const stamp = Date.now();

  await signup(page, `active-team-control-${stamp}@rakazo.test`, "Active Team Control");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);

  await sendMessage(page, "keep working until I stop you");
  await expect
    .poll(async () => (await threadSnapshot(page, chiefId)).run?.status ?? "idle")
    .toBe("running");
  await expect
    .poll(
      async () => (await rpc<{ state: string }>(page, "computer/status", { botId: chiefId })).state,
    )
    .toBe("running");

  const takeover = await rpcResponse(page, "computer/takeover", { botId: chiefId });
  expect(takeover.ok).toBe(false);
  expect(takeover.status).toBe(409);
  await expect
    .poll(async () => (await threadSnapshot(page, chiefId)).run?.status ?? "idle")
    .toBe("running");

  await rpc(page, "threads/stop", { botId: chiefId });
  await waitForRun(page, chiefId);
  await expect
    .poll(async () => (await rpcResponse(page, "computer/takeover", { botId: chiefId })).ok)
    .toBe(true);
  await rpc(page, "computer/release", { botId: chiefId });
});

async function signup(page: Page, email: string, name: string) {
  await page.goto("/sign-up");
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill("password12");
  await page.getByRole("button", { name: "Create account" }).click();
}

async function completeOnboarding(page: Page) {
  await page.waitForURL(/\/(onboarding|app)/, { timeout: 20_000 });
  const heading = page.getByRole("heading", { name: /Connect a model|Create your first bot/ });
  const chief = page.getByText("Chief").first();
  await heading.or(chief).waitFor({ timeout: 20_000 });
  if ((await chief.isVisible().catch(() => false)) && page.url().includes("/app")) return;
  if (
    await page
      .getByRole("heading", { name: "Connect a model" })
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.getByRole("heading", { name: "Create your first bot" }).waitFor();
  }
  if (
    await page
      .getByRole("heading", { name: "Create your first bot" })
      .isVisible()
      .catch(() => false)
  ) {
    await page.locator("label:has-text('Name') input").fill("Chief");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText("A bit of everything", { exact: true }).click();
    await page.getByText("Clear and tight", { exact: true }).click();
    await page.getByRole("button", { name: "Open Rakazo" }).click();
  }
  await page.waitForURL(/\/app/);
  await expect(chief).toBeVisible();
}

async function createBot(page: Page, name: string, mode: "team" | "dedicated") {
  await page.getByTitle("New bot").click();
  await expect(page.getByText("New bot", { exact: true })).toBeVisible();
  const team = page.getByRole("button", { name: "Team", exact: true });
  const privateComputer = page.getByRole("button", { name: "Private", exact: true });
  await expect(team).toHaveAttribute("aria-pressed", "true");
  if (mode === "dedicated") await privateComputer.click();
  await expect(mode === "team" ? team : privateComputer).toHaveAttribute("aria-pressed", "true");
  await page.getByPlaceholder("Name this bot").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
  return activeBotId(page);
}

async function setComputerMode(
  page: Page,
  botName: string,
  botId: string,
  mode: "team" | "dedicated",
) {
  await page.getByRole("button", { name: botName, exact: true }).last().click();
  await expect(page.locator("label:has-text('Name') input")).toHaveValue(botName);
  await page
    .getByRole("button", { name: mode === "team" ? "Team" : "Private", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(async () => {
      const bots = await rpc<Array<{ id: string; computerMode: string }>>(page, "bots/list", {});
      return bots.find((bot) => bot.id === botId)?.computerMode;
    })
    .toBe(mode);
}

async function openBot(page: Page, name: string) {
  await page
    .getByRole("complementary")
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
}

async function openComputerPanel(page: Page) {
  await page.getByTitle("Agent computer").click();
  await expect(page.getByRole("button", { name: "Take control", exact: true })).toBeVisible();
}

async function sendAndWait(page: Page, botId: string, text: string) {
  await sendMessage(page, text);
  await waitForRun(page, botId);
}

async function sendMessage(page: Page, text: string) {
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(text);
  const sent = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/threads/send") && response.request().method() === "POST",
  );
  await page.keyboard.press("Enter");
  expect((await sent).ok()).toBe(true);
}

async function waitForRun(page: Page, botId: string) {
  await expect
    .poll(async () => (await threadSnapshot(page, botId)).run?.status ?? "idle", {
      timeout: 20_000,
    })
    .toBe("idle");
}

function activeBotId(page: Page) {
  const id = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  if (!id || id === "app") throw new Error(`missing bot id in ${page.url()}`);
  return id;
}

function threadSnapshot(page: Page, botId: string) {
  return rpc<{ run: { status: string } | null }>(page, "threads/get", { botId });
}

async function readFile(page: Page, botId: string, path: string) {
  const result = await rpc<{ content: string }>(page, "computer/readFile", { botId, path });
  return result.content;
}

async function readFileResponse(page: Page, botId: string, path: string) {
  return rpcResponse(page, "computer/readFile", { botId, path });
}

async function rpcResponse(page: Page, procedure: string, body: unknown) {
  const response = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  return { ok: response.ok(), status: response.status() };
}

async function rpc<T>(page: Page, procedure: string, body: unknown): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  const parsed = (await response.json()) as { json?: T; error?: { message?: string } };
  if (!response.ok() || parsed.error) {
    throw new Error(`${procedure} ${response.status()}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}
