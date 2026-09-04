import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";

const APP_MARKER = "Local Rakazo stack ready";
const IMAGE_TAG = "v9.9.9";
const STACK_PROBE_PATH = "/.well-known/rakazo-desktop-stack";
const STACK_TOKEN_HEADER = "x-rakazo-desktop-stack-token";
const COMPOSE_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "infra", "compose");

type FakeDockerMode = "ok" | "daemon-down" | "pull-fails";

let server: Server;
let serverUrl: string;
let userData: string;
let app: ElectronApplication | undefined;

// The fake docker is a POSIX shell script; Windows desktop e2e does not run in CI.
test.skip(process.platform === "win32", "fake docker needs a POSIX shell");

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (request.url === STACK_PROBE_PATH && request.method === "GET") {
      const expected = await readFile(path.join(userData, "stack", ".desktop-stack-token"), "utf8")
        .then((value) => value.trim())
        .catch(() => null);
      if (expected === null || request.headers[STACK_TOKEN_HEADER] !== expected) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, imageTag: IMAGE_TAG }));
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
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test.beforeEach(async () => {
  // The fake docker logs $PWD, which is the resolved path (macOS /var is a symlink).
  userData = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-desktop-stack-")));
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(userData, { recursive: true, force: true });
});

function fakeDockerLog() {
  return path.join(userData, "fake-docker.log");
}

/**
 * Stands in for the docker CLI: records `cwd | RAKAZO_IMAGE_TAG | argv` for every call and
 * answers the handful of commands the app issues. The log path and mode are baked into the
 * script because the app passes docker an allowlisted environment.
 */
async function writeFakeDocker(mode: FakeDockerMode) {
  const script = path.join(userData, "fake-docker.sh");
  const lines = [
    "#!/bin/sh",
    `printf '%s | %s | %s\\n' "$PWD" "$RAKAZO_IMAGE_TAG" "$*" >> '${fakeDockerLog()}'`,
    'case "$1 $2" in',
    '  "compose version") echo "2.29.0"; exit 0 ;;',
    '  "info --format")',
    mode === "daemon-down"
      ? '    echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1 ;;'
      : '    echo "27.1.1"; exit 0 ;;',
    "esac",
    "# compose --env-file .env -f docker-compose.images.yml <command> ...",
    'case "$6" in',
    "  pull)",
    mode === "pull-fails"
      ? '    echo "Error response from daemon: manifest unknown" >&2; exit 1 ;;'
      : '    echo "app Pulled"; sleep 2; echo "computer Pulled"; exit 0 ;;',
    '  up) echo "Container rakazo-web-1 Started"; exit 0 ;;',
    '  logs) echo "web-1 | listening"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ];
  await writeFile(script, lines.join("\n"), { encoding: "utf8", mode: 0o755 });
  return script;
}

async function launch(mode: FakeDockerMode | "missing") {
  const env = { ...process.env, RAKAZO_PERFORMANCE_USER_DATA: userData };
  // A stale RAKAZO_WEB_URL from the developer's shell would bypass setup entirely.
  delete env.RAKAZO_WEB_URL;
  return electron.launch({
    args: ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...env,
      RAKAZO_DOCKER_BINARY:
        mode === "missing" ? "/nonexistent/docker" : await writeFakeDocker(mode),
      RAKAZO_LOCAL_WEB_URL: serverUrl,
      RAKAZO_IMAGE_TAG: IMAGE_TAG,
    },
  });
}

async function savedSetup() {
  try {
    return JSON.parse(await readFile(path.join(userData, "setup.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readLog() {
  try {
    return (await readFile(fakeDockerLog(), "utf8")).trim().split("\n");
  } catch {
    return [];
  }
}

test("This computer installs and starts the stack, then opens the app", async () => {
  app = await launch("ok");
  const setup = await app.firstWindow();

  await expect(setup.getByRole("radio", { name: /This computer/ })).toBeChecked();
  // The panel is empty until a start begins, so check the attribute rather than the box.
  await expect(setup.locator("#panel-new")).toHaveJSProperty("hidden", false);
  await expect(setup.locator("#stack")).toBeHidden();
  await expect(setup.getByRole("button", { name: "Check connection" })).toBeHidden();

  const appWindowPromise = app.waitForEvent("window");
  await setup.getByRole("button", { name: "Continue" }).click();
  await expect(setup.locator("#stack-phase")).toHaveText("Downloading Rakazo images…");
  await expect(setup.locator("#stack-output")).toContainText("app Pulled");
  await expect(setup.getByRole("button", { name: "Continue" })).toBeDisabled();
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "06-setup-installing.png"),
  });

  const appWindow = await appWindowPromise;
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
  await expect.poll(savedSetup).toEqual({ mode: "new", serverUrl });

  const stackDir = path.join(userData, "stack");
  const envFile = path.join(stackDir, ".env");
  const tokenFile = path.join(stackDir, ".desktop-stack-token");
  expect((await stat(envFile)).mode & 0o777).toBe(0o600);
  expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
  expect(await readFile(tokenFile, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
  const env = await readFile(envFile, "utf8");
  expect(env).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]{32}$/m);
  expect(env).toMatch(/^BETTER_AUTH_SECRET=[0-9a-f]{64}$/m);
  expect(env).not.toContain("RAKAZO_IMAGE_TAG=");
  expect(env).not.toContain("RAKAZO_COMPUTER_IMAGE_TAG=");
  await expect(readFile(path.join(stackDir, "docker-compose.images.yml"), "utf8")).resolves.toBe(
    await readFile(path.join(COMPOSE_DIR, "docker-compose.images.yml"), "utf8"),
  );

  const compose = "compose --env-file .env -f docker-compose.images.yml";
  expect(await readLog()).toEqual([
    `${stackDir} | ${IMAGE_TAG} | compose version --short`,
    `${stackDir} | ${IMAGE_TAG} | info --format {{.ServerVersion}}`,
    `${stackDir} | ${IMAGE_TAG} | ${compose} pull`,
    `${stackDir} | ${IMAGE_TAG} | ${compose} up -d --wait --wait-timeout 300`,
  ]);
});

test("without Docker the app explains how to get it and offers to check again", async () => {
  app = await launch("missing");
  const setup = await app.firstWindow();

  await setup.getByRole("button", { name: "Continue" }).click();
  await expect(setup.locator("#stack-phase")).toHaveText(
    "Docker is not installed on this computer.",
  );
  await expect(setup.locator("#stack-phase")).toHaveAttribute("data-tone", "error");
  await expect(setup.getByRole("button", { name: "Docker Desktop" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "OrbStack" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Docker Engine" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Check again" })).toBeEnabled();
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "07-setup-docker-missing.png"),
  });

  // Existing instance stays available without Docker.
  await setup.getByRole("radio", { name: /Existing instance/ }).check();
  await expect(setup.locator("#stack")).toBeHidden();
  await expect(setup.getByRole("button", { name: "Continue" })).toBeEnabled();
  expect(await savedSetup()).toBeNull();
});

test("switching to Existing instance while the stack starts keeps that choice", async () => {
  app = await launch("ok");
  const setup = await app.firstWindow();

  await setup.getByRole("button", { name: "Continue" }).click();
  await expect(setup.locator("#stack-phase")).toHaveText("Downloading Rakazo images…");

  // Fake docker sleeps during pull; leave This computer before ready so followStack must not save.
  await setup.getByRole("radio", { name: /Existing instance/ }).check();
  await expect(setup.locator("#panel-existing")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Continue" })).toBeEnabled();
  await expect(setup.getByRole("button", { name: "Check connection" })).toBeVisible();

  // Main process still finishes the install; setup.json must stay untouched.
  await expect
    .poll(async () => (await readLog()).some((line) => line.includes(" up -d")))
    .toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(await savedSetup()).toBeNull();
  expect(app.windows()).toHaveLength(1);

  // Back on This computer, Continue starts (or re-follows) and opens the app.
  await setup.getByRole("radio", { name: /This computer/ }).check();
  const appWindowPromise = app.waitForEvent("window");
  await setup.getByRole("button", { name: "Continue" }).click();
  await expect((await appWindowPromise).getByText(APP_MARKER)).toBeVisible();
  await expect.poll(savedSetup).toEqual({ mode: "new", serverUrl });
});

test("a stopped Docker daemon is reported and Check again asks Docker once more", async () => {
  app = await launch("daemon-down");
  const setup = await app.firstWindow();

  await setup.getByRole("button", { name: "Continue" }).click();
  await expect(setup.locator("#stack-phase")).toHaveText(
    "Docker is installed but not running. Start Docker, then check again.",
  );
  await expect(setup.getByRole("button", { name: "Docker Desktop" })).toBeVisible();
  expect((await readLog()).filter((line) => line.includes("info --format"))).toHaveLength(1);

  await setup.getByRole("button", { name: "Check again" }).click();
  await expect(setup.getByRole("button", { name: "Check again" })).toBeEnabled();
  expect((await readLog()).filter((line) => line.includes("info --format"))).toHaveLength(2);
  expect((await readLog()).some((line) => line.includes(" pull"))).toBe(false);
});

test("unpublished images show the docker output and a Retry button", async () => {
  app = await launch("pull-fails");
  const setup = await app.firstWindow();

  await setup.getByRole("button", { name: "Continue" }).click();
  await expect(setup.locator("#stack-phase")).toHaveText(
    `Images for ${IMAGE_TAG} are not published yet. Try again in a few minutes.`,
  );
  await expect(setup.locator("#stack-output")).toContainText("manifest unknown");
  await expect(setup.getByRole("button", { name: "Retry" })).toBeEnabled();
  await expect(setup.locator("#stack-docker-help")).toBeHidden();
  expect((await readLog()).some((line) => line.endsWith(" up -d --wait --wait-timeout 300"))).toBe(
    false,
  );
});

test("a saved local stack that is down is started again without asking", async () => {
  // Nothing listens on the saved address, so the launch probe fails and the stack is restarted.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("probe has no port");
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  await writeFile(
    path.join(userData, "setup.json"),
    `${JSON.stringify({ mode: "new", serverUrl: `http://127.0.0.1:${address.port}` }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  app = await launch("ok");
  const setup = await app.firstWindow();
  await expect(setup.getByRole("radio", { name: /This computer/ })).toBeChecked();
  await expect(setup.locator("#stack")).toBeVisible();
  await expect(setup.locator("#status")).toBeEmpty();

  const appWindow = await app.waitForEvent("window");
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
  await expect.poll(savedSetup).toEqual({ mode: "new", serverUrl });
  expect((await readLog()).some((line) => line.includes(" pull"))).toBe(true);
});

test("a saved local stack is reused only after its private identity matches", async () => {
  const stackDir = path.join(userData, "stack");
  await mkdir(stackDir, { recursive: true });
  await writeFile(path.join(stackDir, ".desktop-stack-token"), `${"ab".repeat(32)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    path.join(userData, "setup.json"),
    `${JSON.stringify({ mode: "new", serverUrl }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  app = await launch("ok");
  const appWindow = await app.firstWindow();
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
  expect(await readLog()).toEqual([]);
});

test("a saved local target is the exact origin authenticated before reuse", async () => {
  const uncheckedServer = createServer((request, response) => {
    if (request.url === "/rpc/health" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ json: { ok: true, version: "0.1.0" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>Unchecked listener</body></html>");
  });
  await new Promise<void>((resolve) => uncheckedServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = uncheckedServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("unchecked server has no port");
    }
    const stackDir = path.join(userData, "stack");
    await mkdir(stackDir, { recursive: true });
    await writeFile(path.join(stackDir, ".desktop-stack-token"), `${"ab".repeat(32)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeFile(
      path.join(userData, "setup.json"),
      `${JSON.stringify(
        { mode: "new", serverUrl: `http://127.0.0.1:${address.port}` },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    app = await launch("ok");
    const setup = await app.firstWindow();
    await expect(setup.getByRole("radio", { name: /This computer/ })).toBeChecked();
    await expect(setup.locator("#stack")).toBeVisible();
    await expect(setup.getByText("Unchecked listener")).toHaveCount(0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      uncheckedServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("an existing stack .env is never rewritten", async () => {
  const stackDir = path.join(userData, "stack");
  await mkdir(stackDir, { recursive: true });
  const sentinel = "POSTGRES_PASSWORD=keep-me\nSENTINEL=1\n";
  await writeFile(path.join(stackDir, ".env"), sentinel, { encoding: "utf8", mode: 0o600 });

  app = await launch("ok");
  const setup = await app.firstWindow();
  const appWindowPromise = app.waitForEvent("window");
  await setup.getByRole("button", { name: "Continue" }).click();
  const appWindow = await appWindowPromise;
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();

  await expect(readFile(path.join(stackDir, ".env"), "utf8")).resolves.toBe(sentinel);
});
