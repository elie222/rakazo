import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

const APP_MARKER = "Existing Rakazo instance ready";
/** Outlasts the shell's 20s wait for a mounted app before it rejects the server. */
const NOT_READY_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

let server: Server;
let serverUrl: string;
let closedUrl: string;
let userData: string;
let app: ElectronApplication | undefined;
let monitoringRequests = 0;

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
  server = createServer((request, response) => {
    if (request.url === "/api/monitoring/config") {
      monitoringRequests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ dsn: null }));
      return;
    }
    if (request.url === "/rpc/health" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ json: { ok: true, version: "0.1.0" } }));
      return;
    }
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
  const executablePath = process.env.RAKAZO_E2E_EXECUTABLE;
  return electron.launch({
    ...(executablePath ? { executablePath: path.resolve(executablePath) } : {}),
    args: executablePath ? [] : ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...env, ...extraEnv },
  });
}

test("first run offers Rakazo Cloud first, with local and existing instances", async () => {
  app = await launch();
  if (process.env.RAKAZO_E2E_EXECUTABLE) {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  }
  const setup = await app.firstWindow();

  await expect(setup.getByRole("heading", { name: "Welcome to Rakazo" })).toBeVisible();
  await expect(setup.getByText("Choose which server this app should use.")).toBeVisible();
  await expect(setup.getByText("Rakazo Cloud")).toBeVisible();
  await expect(setup.getByText("This computer")).toBeVisible();
  await expect(setup.getByText("Existing instance")).toBeVisible();
  await expect(setup.locator(".card")).toHaveCount(0);

  // Cloud is the default: one click opens the hosted app, with nothing to fill in.
  await expect(setup.getByRole("radio", { name: /Rakazo Cloud/ })).toBeChecked();
  await expect(setup.locator("#panel-new")).toBeHidden();
  await expect(setup.locator("#panel-existing")).toBeHidden();
  await expect(setup.getByRole("button", { name: "Check connection" })).toBeHidden();
  await expect(setup.getByRole("button", { name: "Continue" })).toBeEnabled();
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "00-setup-cloud.png"),
  });

  // This computer runs the stack itself at the local address.
  await setup.getByRole("radio", { name: /This computer/ }).check();
  // The panel is empty until a start begins, so check the attribute rather than the box.
  await expect(setup.locator("#panel-new")).toHaveJSProperty("hidden", false);
  await expect(setup.locator("#stack")).toBeHidden();
  await expect(setup.getByRole("button", { name: "Check connection" })).toBeHidden();
  await expect(setup.locator("#panel-existing")).toBeHidden();

  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "01-setup-new-instance.png"),
  });

  // Linux CI verifies the layout state; the macOS CI job also captures the native controls.
  await setup.evaluate(() => {
    document.documentElement.dataset.platform = "darwin";
  });
  await expect(setup.locator(".titlebar")).toHaveCSS("padding-left", "88px");
  expect((await setup.locator(".titlebar-name").boundingBox())?.x).toBeGreaterThanOrEqual(88);
  if (process.platform === "darwin") {
    if (process.env.CI) {
      await execFileAsync("screencapture", [
        "-x",
        path.join(import.meta.dirname, "screenshots", "09-macos-dock.png"),
      ]);
    }
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Setup window is unavailable");
      window.setBounds({ x: 40, y: 40, width: 720, height: 700 });
      window.show();
      window.focus();
    });
    await setup.waitForTimeout(500);
    await execFileAsync("screencapture", [
      "-x",
      "-R40,40,720,700",
      path.join(import.meta.dirname, "screenshots", "08-setup-macos-native-controls.png"),
    ]);
  }
});

test("Rakazo Cloud saves the hosted address and is reselected when saved", async () => {
  app = await launch();
  const setup = await app.firstWindow();
  await expect(setup.getByRole("radio", { name: /Rakazo Cloud/ })).toBeChecked();
  await expect(setup.getByRole("button", { name: "Continue" })).toBeEnabled();

  // Capture the request instead of reaching the hosted server, so CI stays offline.
  const { cloudUrl } = await setup.evaluate(() =>
    (
      window as typeof window & { rakazoSetup: { state: () => Promise<{ cloudUrl: string }> } }
    ).rakazoSetup.state(),
  );
  expect(cloudUrl).toMatch(/^https:\/\//);
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & { cloudSaves?: unknown[] };
    state.cloudSaves = [];
    ipcMain.removeHandler("desktop.setup.save");
    ipcMain.handle("desktop.setup.save", (_event, payload: unknown) => {
      state.cloudSaves?.push(payload);
      return { ok: false, error: "Captured." };
    });
  });
  await setup.getByRole("button", { name: "Continue" }).click();
  await expect(setup.locator("#status")).toHaveText("Captured.");
  expect(
    await app.evaluate(
      () => (globalThis as typeof globalThis & { cloudSaves?: unknown[] }).cloudSaves,
    ),
  ).toEqual([{ mode: "existing", serverUrl: cloudUrl }]);
  expect(await readFile(path.join(userData, "setup.json"), "utf8").catch(() => null)).toBeNull();

  // A saved Cloud setup reopens with Cloud chosen, not as a typed existing address.
  await app.evaluate(({ ipcMain }, url) => {
    ipcMain.removeHandler("desktop.setup.state");
    ipcMain.handle("desktop.setup.state", () => ({
      defaultLocalUrl: "http://127.0.0.1:45173",
      cloudUrl: url,
      saved: { mode: "existing", serverUrl: url },
    }));
  }, cloudUrl);
  await setup.reload();
  await expect(setup.getByRole("radio", { name: /Rakazo Cloud/ })).toBeChecked();
  await expect(setup.locator("#panel-existing")).toBeHidden();
});

test("connecting to an existing instance verifies, saves, and opens it", async () => {
  app = await launch();
  const setup = await app.firstWindow();

  await setup.getByRole("radio", { name: /Existing instance/ }).check();
  await expect(setup.locator("#panel-new")).toBeHidden();

  await setup.locator("#server-url").fill(serverUrl);
  await setup.getByRole("button", { name: "Check connection" }).click();
  await expect(setup.locator("#status")).toHaveText(`Rakazo answered at ${serverUrl}.`);
  await expect(setup.locator("#status")).toHaveAttribute("data-tone", "ok");

  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "02-setup-existing-verified.png"),
  });

  const appWindow = await Promise.all([
    app.waitForEvent("window"),
    setup.getByRole("button", { name: "Continue" }).click(),
  ]).then(([window]) => window);

  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
  await appWindow.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "03-connected-instance.png"),
  });

  // Continue can paint the app window before setup.json finishes flushing to disk.
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(path.join(userData, "setup.json"), "utf8"));
      } catch {
        return null;
      }
    })
    .toEqual({ mode: "existing", serverUrl });
});

test("Continue verifies and remembers the instance so setup does not run again", async () => {
  app = await launch();
  const setup = await app.firstWindow();
  await setup.getByRole("radio", { name: /Existing instance/ }).check();
  await setup.locator("#server-url").fill(serverUrl);
  const firstRun = await Promise.all([
    app.waitForEvent("window"),
    setup.getByRole("button", { name: "Continue" }).click(),
  ]).then(([window]) => window);
  await expect(firstRun.getByText(APP_MARKER)).toBeVisible();
  // Continue can paint the app window before setup.json finishes flushing to disk.
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(path.join(userData, "setup.json"), "utf8"));
      } catch {
        return null;
      }
    })
    .toEqual({ mode: "existing", serverUrl });
  await app.close();

  app = await launch();
  const relaunched = await app.firstWindow();
  await expect(relaunched.getByText(APP_MARKER)).toBeVisible();
  await expect(relaunched.locator("#setup")).toHaveCount(0);
});

test("an unreachable address is reported instead of being saved", async () => {
  app = await launch();
  const setup = await app.firstWindow();

  await setup.getByRole("radio", { name: /Existing instance/ }).check();
  await setup.locator("#server-url").fill(closedUrl);
  await setup.getByRole("button", { name: "Check connection" }).click();

  await expect(setup.locator("#status")).toHaveAttribute("data-tone", "error");
  await expect(setup.locator("#status")).toHaveText("Nothing is listening at that address yet.");
  await setup.getByRole("button", { name: "Continue" }).click();
  await expect(setup.locator("#status")).toHaveText("Nothing is listening at that address yet.");
  await expect(async () => {
    await expect(readFile(path.join(userData, "setup.json"), "utf8")).rejects.toThrow();
  }).toPass();
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "04-setup-unreachable.png"),
  });
});

test("an HTTP error document is not accepted after a healthy probe", async () => {
  const broken = createServer((request, response) => {
    if (request.url === "/rpc/health" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ json: { ok: true, version: "0.1.0" } }));
      return;
    }
    response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body><h1>Unavailable</h1></body></html>");
  });
  await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
  const address = broken.address();
  if (address === null || typeof address === "string") throw new Error("broken server has no port");

  try {
    app = await launch();
    const setup = await app.firstWindow();
    await setup.getByRole("radio", { name: /Existing instance/ }).check();
    await setup.locator("#server-url").fill(`http://127.0.0.1:${address.port}`);
    await setup.getByRole("button", { name: "Continue" }).click();

    await expect(setup.locator("#status")).toContainText("Could not open that server.");
    await expect(async () => {
      await expect(readFile(path.join(userData, "setup.json"), "utf8")).rejects.toThrow();
    }).toPass();
  } finally {
    await new Promise<void>((resolve, reject) => {
      broken.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("a session-pending shell skeleton is not accepted as a ready app", async () => {
  test.setTimeout(2 * NOT_READY_TIMEOUT_MS);
  const skeletonHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rakazo</title></head>
<body><div id="root"><div data-rakazo-app-state="session-pending"><aside></aside><main><div>Opening your Space…</div></main></div></div></body></html>`;
  const skeleton = createServer((request, response) => {
    if (request.url === "/rpc/health" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ json: { ok: true, version: "0.1.0" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(skeletonHtml);
  });
  await new Promise<void>((resolve) => skeleton.listen(0, "127.0.0.1", resolve));
  const address = skeleton.address();
  if (address === null || typeof address === "string")
    throw new Error("skeleton server has no port");

  try {
    app = await launch();
    const setup = await app.firstWindow();
    await setup.getByRole("radio", { name: /Existing instance/ }).check();
    await setup.locator("#server-url").fill(`http://127.0.0.1:${address.port}`);
    await setup.getByRole("button", { name: "Continue" }).click();

    await expect(setup.locator("#status")).toContainText("Could not open that server.", {
      timeout: NOT_READY_TIMEOUT_MS,
    });
    await expect(async () => {
      await expect(readFile(path.join(userData, "setup.json"), "utf8")).rejects.toThrow();
    }).toPass();
  } finally {
    await new Promise<void>((resolve, reject) => {
      skeleton.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

for (const { name, surface } of [
  {
    name: "bootstrapped workspace",
    surface: '<div data-testid="shell-root" data-ready="true">Workspace</div>',
  },
  {
    name: "logged-out welcome",
    surface: '<div data-rakazo-surface="welcome"><button>Sign up</button></div>',
  },
  {
    name: "translated logged-out welcome",
    surface: '<div data-rakazo-surface="welcome"><button>Créer un compte</button></div>',
  },
]) {
  test(`a post-session ${name} mount is accepted`, async () => {
    const readyHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rakazo</title>
</head>
<body><div id="root"><div data-rakazo-app-state="ready">${surface}</div></div></body></html>`;
    const ready = createServer((request, response) => {
      if (request.url === "/rpc/health" && request.method === "POST") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ json: { ok: true, version: "0.1.0" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(readyHtml);
    });
    await new Promise<void>((resolve) => ready.listen(0, "127.0.0.1", resolve));
    const address = ready.address();
    if (address === null || typeof address === "string")
      throw new Error("ready server has no port");

    try {
      app = await launch();
      const setup = await app.firstWindow();
      await setup.getByRole("radio", { name: /Existing instance/ }).check();
      await setup.locator("#server-url").fill(`http://127.0.0.1:${address.port}`);
      const appWindow = await Promise.all([
        app.waitForEvent("window"),
        setup.getByRole("button", { name: "Continue" }).click(),
      ]).then(([window]) => window);

      await expect(appWindow.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
      await expect
        .poll(async () => {
          try {
            return JSON.parse(await readFile(path.join(userData, "setup.json"), "utf8"));
          } catch {
            return null;
          }
        })
        .toEqual({
          mode: "existing",
          serverUrl: `http://127.0.0.1:${address.port}`,
        });
    } finally {
      await new Promise<void>((resolve, reject) => {
        ready.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}

test("a shell mount before workspace bootstrap is not accepted", async () => {
  test.setTimeout(2 * NOT_READY_TIMEOUT_MS);
  const preBootstrapHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rakazo</title></head>
<body><div id="root"><div data-rakazo-app-state="ready"><div data-testid="shell-root" data-ready="false">Workspace</div></div></div></body></html>`;
  const preBootstrap = createServer((request, response) => {
    if (request.url === "/rpc/health" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ json: { ok: true, version: "0.1.0" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(preBootstrapHtml);
  });
  await new Promise<void>((resolve) => preBootstrap.listen(0, "127.0.0.1", resolve));
  const address = preBootstrap.address();
  if (address === null || typeof address === "string")
    throw new Error("pre-bootstrap server has no port");

  try {
    app = await launch();
    const setup = await app.firstWindow();
    await setup.getByRole("radio", { name: /Existing instance/ }).check();
    await setup.locator("#server-url").fill(`http://127.0.0.1:${address.port}`);
    await setup.getByRole("button", { name: "Continue" }).click();

    await expect(setup.locator("#status")).toContainText("Could not open that server.", {
      timeout: NOT_READY_TIMEOUT_MS,
    });
    await expect(async () => {
      await expect(readFile(path.join(userData, "setup.json"), "utf8")).rejects.toThrow();
    }).toPass();
  } finally {
    await new Promise<void>((resolve, reject) => {
      preBootstrap.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("a session-ready marker without a route surface is not accepted", async () => {
  test.setTimeout(2 * NOT_READY_TIMEOUT_MS);
  const emptyReadyHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rakazo</title></head>
<body><div id="root"><div data-rakazo-app-state="ready" class="h-full"></div></div></body></html>`;
  const emptyReady = createServer((request, response) => {
    if (request.url === "/rpc/health" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ json: { ok: true, version: "0.1.0" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(emptyReadyHtml);
  });
  await new Promise<void>((resolve) => emptyReady.listen(0, "127.0.0.1", resolve));
  const address = emptyReady.address();
  if (address === null || typeof address === "string")
    throw new Error("empty-ready server has no port");

  try {
    app = await launch();
    const setup = await app.firstWindow();
    await setup.getByRole("radio", { name: /Existing instance/ }).check();
    await setup.locator("#server-url").fill(`http://127.0.0.1:${address.port}`);
    await setup.getByRole("button", { name: "Continue" }).click();

    await expect(setup.locator("#status")).toContainText("Could not open that server.", {
      timeout: NOT_READY_TIMEOUT_MS,
    });
    await expect(async () => {
      await expect(readFile(path.join(userData, "setup.json"), "utf8")).rejects.toThrow();
    }).toPass();
  } finally {
    await new Promise<void>((resolve, reject) => {
      emptyReady.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("a malformed address is rejected before anything is written", async () => {
  app = await launch();
  const setup = await app.firstWindow();

  await setup.getByRole("radio", { name: /Existing instance/ }).check();
  await setup.locator("#server-url").fill("not a server");
  await setup.getByRole("button", { name: "Continue" }).click();

  await expect(setup.locator("#status")).toContainText("Enter a valid server address.");
  await expect(async () => {
    await expect(readFile(path.join(userData, "setup.json"), "utf8")).rejects.toThrow();
  }).toPass();
});

test("a generic web page is not accepted as a Rakazo server", async () => {
  const plain = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><p>not Rakazo</p>");
  });
  await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
  const address = plain.address();
  if (address === null || typeof address === "string") throw new Error("plain server has no port");

  try {
    app = await launch();
    const setup = await app.firstWindow();
    await setup.getByRole("radio", { name: /Existing instance/ }).check();
    await setup.locator("#server-url").fill(`http://127.0.0.1:${address.port}`);
    await setup.getByRole("button", { name: "Continue" }).click();

    await expect(setup.locator("#status")).toHaveText(
      "That address did not respond like a Rakazo server.",
    );
    await expect(async () => {
      await expect(readFile(path.join(userData, "setup.json"), "utf8")).rejects.toThrow();
    }).toPass();
  } finally {
    await new Promise<void>((resolve, reject) => {
      plain.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("the setup probe refuses redirects instead of following them", async () => {
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { location: `${serverUrl}/rpc/health` });
    response.end();
  });
  await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  const address = redirect.address();
  if (address === null || typeof address === "string") {
    throw new Error("redirect server has no port");
  }

  try {
    app = await launch();
    const setup = await app.firstWindow();
    await setup.getByRole("radio", { name: /Existing instance/ }).check();
    await setup.locator("#server-url").fill(`http://127.0.0.1:${address.port}`);
    await setup.getByRole("button", { name: "Continue" }).click();

    // Electron's net.fetch with redirect:"manual" surfaces redirects as a
    // network failure rather than an HTTP 3xx body we can classify.
    await expect(setup.locator("#status")).toHaveText("Could not reach that address.");
    await expect(async () => {
      await expect(readFile(path.join(userData, "setup.json"), "utf8")).rejects.toThrow();
    }).toPass();
  } finally {
    await new Promise<void>((resolve, reject) => {
      redirect.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("an unreachable saved server falls back to setup with a recovery message", async () => {
  await writeFile(
    path.join(userData, "setup.json"),
    `${JSON.stringify({ mode: "existing", serverUrl: closedUrl }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  app = await launch();
  const setup = await app.firstWindow();

  await expect(setup.getByRole("heading", { name: "Welcome to Rakazo" })).toBeVisible();
  await expect(setup.getByRole("radio", { name: /Existing instance/ })).toBeChecked();
  await expect(setup.locator("#server-url")).toHaveValue(closedUrl);
  await expect(setup.locator("#status")).toContainText("Could not reconnect to the saved server.");
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "05-saved-server-recovery.png"),
  });
});

test("the native application menu can reopen setup without exposing setup IPC to the server", async () => {
  app = await launch({ RAKAZO_WEB_URL: serverUrl });
  const appWindow = await app.firstWindow();
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();

  const setupPromise = app.waitForEvent("window");
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("change-rakazo-server");
    if (!item) throw new Error("Change server menu item is missing");
    item.click();
  });
  const setup = await setupPromise;

  await expect(setup.getByRole("heading", { name: "Welcome to Rakazo" })).toBeVisible();
  await expect(setup.locator("#status")).toBeEmpty();

  // Closing setup without saving restores the connected instance.
  await setup.close();
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
});

test("servers on the same host but different ports do not share login cookies", async () => {
  const monitoringDisabled = (requestUrl: string | undefined, response: ServerResponse) => {
    if (requestUrl !== "/api/monitoring/config") return false;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ dsn: null }));
    return true;
  };
  const first = createServer((request, response) => {
    if (monitoringDisabled(request.url, response)) return;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "rakazo_session=fake-one; Path=/; SameSite=Lax",
    });
    response.end("<!doctype html><main>Cookie stored</main>");
  });
  const second = createServer((request, response) => {
    if (monitoringDisabled(request.url, response)) return;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><main>Cookies: ${request.headers.cookie ?? "none"}</main>`);
  });
  await Promise.all([
    new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => second.listen(0, "127.0.0.1", resolve)),
  ]);
  const firstAddress = first.address();
  const secondAddress = second.address();
  if (
    firstAddress === null ||
    typeof firstAddress === "string" ||
    secondAddress === null ||
    typeof secondAddress === "string"
  ) {
    throw new Error("cookie fixture server has no port");
  }

  try {
    app = await launch({ RAKAZO_WEB_URL: `http://127.0.0.1:${firstAddress.port}` });
    const firstWindow = await app.firstWindow();
    await expect(firstWindow.getByText("Cookie stored")).toBeVisible();
    await expect.poll(() => firstWindow.evaluate(() => document.cookie)).toContain("fake-one");
    await app.close();

    app = await launch({ RAKAZO_WEB_URL: `http://127.0.0.1:${secondAddress.port}` });
    const secondWindow = await app.firstWindow();
    await expect(secondWindow.getByText("Cookies: none")).toBeVisible();
  } finally {
    await app?.close();
    app = undefined;
    await Promise.all([
      new Promise<void>((resolve, reject) =>
        first.close((error) => (error ? reject(error) : resolve())),
      ),
      new Promise<void>((resolve, reject) =>
        second.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
  }
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

for (const failure of ["load", "save"] as const) {
  test(`desktop monitoring follows the restored session after a ${failure} failure`, async () => {
    await writeFile(
      path.join(userData, "setup.json"),
      JSON.stringify({ mode: "existing", serverUrl }),
    );
    const initialRequests = monitoringRequests;
    app = await launch();
    const previous = await app.firstWindow();
    await expect(previous.getByText(APP_MARKER)).toBeVisible();
    await expect.poll(() => monitoringRequests).toBeGreaterThan(initialRequests);
    const connectedRequests = monitoringRequests;
    const attempted = createServer((request, response) => {
      if (request.url === "/rpc/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ json: { ok: true, version: "0.1.0" } }));
      } else if (request.url === "/api/monitoring/config") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ dsn: null }));
      } else {
        response.writeHead(failure === "load" ? 500 : 200, { "content-type": "text/html" });
        response.end(`<!doctype html><html><body><main>${APP_MARKER}</main></body></html>`);
      }
    });
    await new Promise<void>((resolve) => attempted.listen(0, "127.0.0.1", resolve));
    const address = attempted.address();
    if (!address || typeof address === "string") throw new Error("fixture has no port");
    try {
      const setupPromise = app.waitForEvent("window");
      await app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById("change-rakazo-server");
        if (!item) throw new Error("Change server menu item is missing");
        item.click();
      });
      const setup = await setupPromise;
      await setup.getByRole("radio", { name: /Existing instance/ }).check();
      await setup.locator("#server-url").fill(`http://127.0.0.1:${address.port}`);
      if (failure === "save") {
        await rm(path.join(userData, "setup.json"));
        await mkdir(path.join(userData, "setup.json"));
      }
      await setup.getByRole("button", { name: "Continue" }).click();
      await expect(setup.locator("#status")).toContainText(
        failure === "load" ? "Could not open that server." : "The previous instance was restored.",
      );
      if (failure === "save")
        await expect.poll(() => monitoringRequests).toBeGreaterThan(connectedRequests);
      // A cookie event on the original session must still refresh that server's identity.
      const beforeCookie = monitoringRequests;
      await previous.evaluate(() => {
        document.cookie = `monitoring-test=${Date.now()}; path=/`;
      });
      await expect.poll(() => monitoringRequests).toBeGreaterThan(beforeCookie);
    } finally {
      await app?.close();
      app = undefined;
      await new Promise<void>((resolve) => attempted.close(() => resolve()));
    }
  });
}
