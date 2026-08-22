import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";

const APP_MARKER = "Existing Rakazo instance ready";

let server: Server;
let serverUrl: string;
let closedUrl: string;
let userData: string;
let app: ElectronApplication | undefined;

/** A port nothing listens on, so a connection attempt is refused rather than blocked. */
async function reserveClosedPort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("probe has no port");
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${port}`;
}

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rakazo</title></head><body><main>${APP_MARKER}</main></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub server has no port");
  serverUrl = `http://127.0.0.1:${address.port}`;
  closedUrl = await reserveClosedPort();
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test.beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "rakazo-desktop-e2e-"));
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(userData, { recursive: true, force: true });
});

function launch(extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, RAKAZO_PERFORMANCE_USER_DATA: userData };
  // A stale RAKAZO_WEB_URL from the developer's shell would bypass setup entirely.
  delete env.RAKAZO_WEB_URL;
  return electron.launch({
    args: ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...env, ...extraEnv },
  });
}

test("first run asks whether to create a new instance or connect to an existing one", async () => {
  app = await launch();
  const setup = await app.firstWindow();

  await expect(setup.getByRole("heading", { name: "Welcome to Rakazo" })).toBeVisible();
  await expect(setup.getByText("Set up a new instance")).toBeVisible();
  await expect(setup.getByText("Connect to an existing instance")).toBeVisible();

  // A new instance is the default and points at the local development stack.
  await expect(setup.getByRole("radio", { name: /Set up a new instance/ })).toBeChecked();
  await expect(setup.locator("#local-url")).toHaveValue("http://127.0.0.1:5173");
  await expect(setup.locator("#panel-existing")).toBeHidden();

  await setup.screenshot({ path: "e2e/screenshots/01-setup-new-instance.png" });
});

test("connecting to an existing instance verifies, saves, and opens it", async () => {
  app = await launch();
  const setup = await app.firstWindow();

  await setup.getByRole("radio", { name: /Connect to an existing instance/ }).check();
  await expect(setup.locator("#panel-new")).toBeHidden();

  await setup.locator("#server-url").fill(serverUrl);
  await setup.getByRole("button", { name: "Check connection" }).click();
  await expect(setup.locator("#status")).toHaveText(`Rakazo answered at ${serverUrl}.`);
  await expect(setup.locator("#status")).toHaveAttribute("data-tone", "ok");

  await setup.screenshot({ path: "e2e/screenshots/02-setup-existing-verified.png" });

  const appWindow = await Promise.all([
    app.waitForEvent("window"),
    setup.getByRole("button", { name: "Continue" }).click(),
  ]).then(([window]) => window);

  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
  await appWindow.screenshot({ path: "e2e/screenshots/03-connected-instance.png" });

  const saved = JSON.parse(await readFile(path.join(userData, "setup.json"), "utf8"));
  expect(saved).toEqual({ mode: "existing", serverUrl });
});

test("a verified instance is remembered so setup does not run again", async () => {
  app = await launch();
  const setup = await app.firstWindow();
  await setup.getByRole("radio", { name: /Connect to an existing instance/ }).check();
  await setup.locator("#server-url").fill(serverUrl);
  const firstRun = await Promise.all([
    app.waitForEvent("window"),
    setup.getByRole("button", { name: "Continue" }).click(),
  ]).then(([window]) => window);
  await expect(firstRun.getByText(APP_MARKER)).toBeVisible();
  await app.close();

  app = await launch();
  const relaunched = await app.firstWindow();
  await expect(relaunched.getByText(APP_MARKER)).toBeVisible();
  await expect(relaunched.locator("#setup")).toHaveCount(0);
});

test("an unreachable address is reported instead of being saved", async () => {
  app = await launch();
  const setup = await app.firstWindow();

  await setup.getByRole("radio", { name: /Connect to an existing instance/ }).check();
  await setup.locator("#server-url").fill(closedUrl);
  await setup.getByRole("button", { name: "Check connection" }).click();

  await expect(setup.locator("#status")).toHaveAttribute("data-tone", "error");
  await expect(setup.locator("#status")).toHaveText("Nothing is listening at that address yet.");
  await setup.screenshot({ path: "e2e/screenshots/04-setup-unreachable.png" });
});

test("a malformed address is rejected before anything is written", async () => {
  app = await launch();
  const setup = await app.firstWindow();

  await setup.getByRole("radio", { name: /Connect to an existing instance/ }).check();
  await setup.locator("#server-url").fill("not a server");
  await setup.getByRole("button", { name: "Continue" }).click();

  await expect(setup.locator("#status")).toHaveText("Enter a valid http:// or https:// address.");
  await expect(async () => {
    await expect(readFile(path.join(userData, "setup.json"), "utf8")).rejects.toThrow();
  }).toPass();
});

test("setup IPC is not reachable from the connected app window", async () => {
  app = await launch({ RAKAZO_WEB_URL: serverUrl });
  const appWindow = await app.firstWindow();
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();

  const exposed = await appWindow.evaluate(() =>
    Object.keys((window as typeof window & { rakazoSetup?: unknown }).rakazoSetup ?? {}),
  );
  expect(exposed).toEqual([]);
});
