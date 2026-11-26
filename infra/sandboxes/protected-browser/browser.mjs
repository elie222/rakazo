import { pathToFileURL } from "node:url";

const TIMEOUT = 8_000;
const MAX_INPUT = 2_000_000;
const MAX_PAGE = 24_000;
const MAX_STEPS = 10;
const ROLES = new Set(["button", "checkbox", "combobox", "link", "radio", "textbox"]);

function webUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Invalid browser URL");
  }
  return url;
}

function checkInput(request) {
  if (!["sign-in", "browse"].includes(request.mode)) throw new Error("Invalid browser mode");
  webUrl(request.url);
  if (
    request.mode === "browse" &&
    (!Array.isArray(request.storageState?.cookies) || !Array.isArray(request.storageState?.origins))
  ) {
    throw new Error("Invalid browser state");
  }
  if (!Array.isArray(request.steps) || request.steps.length > MAX_STEPS) {
    throw new Error("Invalid browser steps");
  }
  for (const step of request.steps) {
    if (!["click", "fill"].includes(step.kind) || !ROLES.has(step.role)) {
      throw new Error("Invalid browser step");
    }
    if (typeof step.name !== "string" || !step.name || step.name.length > 300) {
      throw new Error("Invalid browser control name");
    }
    if (step.kind === "fill" && (typeof step.text !== "string" || step.text.length > 4_096)) {
      throw new Error("Invalid browser field value");
    }
  }
}

async function executeStep(page, step, loginOrigin) {
  const control = page.getByRole(step.role, { name: step.name, exact: true });
  if (step.kind === "click") {
    await control.click({ timeout: TIMEOUT });
    return;
  }
  if (!loginOrigin) {
    await control.fill(step.text, { timeout: TIMEOUT });
    return;
  }

  // Resolve the element before checking its document, so a navigation cannot retarget
  // the fill. A detached element handle fails instead of finding a new field.
  const field = await page
    .getByLabel(step.name, { exact: true })
    .elementHandle({ timeout: TIMEOUT });
  try {
    const frame = await field.ownerFrame();
    if (!frame || webUrl(frame.url()).origin !== loginOrigin) {
      throw new Error("Unexpected sign-in origin");
    }
    await field.fill(step.text, { timeout: TIMEOUT });
  } finally {
    await field.dispose();
  }
}

function pageSnapshot(text, ...states) {
  const values = states.flatMap((storage) => [
    ...storage.cookies.map(({ value }) => value),
    ...storage.origins.flatMap(({ localStorage }) => localStorage.map(({ value }) => value)),
  ]);
  for (const value of [...new Set(values)].sort((a, b) => b.length - a.length)) {
    if (value) {
      text = text.replaceAll(value, "[redacted]");
      const escaped = encodeURIComponent(value);
      if (escaped !== value) text = text.replaceAll(escaped, "[redacted]");
    }
  }
  return text.slice(0, MAX_PAGE);
}

/** One private invocation. The caller keeps storageState on the trusted side of the tool boundary. */
export async function runBrowser(chromium, request, launchOptions = {}) {
  checkInput(request);
  const url = webUrl(request.url);
  const signingIn = request.mode === "sign-in";
  const browser = await chromium.launch({ chromiumSandbox: true, ...launchOptions });
  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      storageState: signingIn ? undefined : request.storageState,
      viewport: { width: 1280, height: 900 },
    });
    context.setDefaultTimeout(TIMEOUT);
    await context.route("**/*", (route) => {
      try {
        webUrl(route.request().url());
      } catch {
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    const initialStorage = signingIn ? null : await context.storageState();
    for (const step of request.steps) {
      await executeStep(page, step, signingIn ? url.origin : undefined);
    }
    const storageState = await context.storageState();
    if (!initialStorage) return { storageState };
    const snapshot = await page.locator("body").ariaSnapshot({ timeout: TIMEOUT });
    return {
      storageState,
      page: pageSnapshot(snapshot, request.storageState, initialStorage, storageState),
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > MAX_INPUT) throw new Error("Invalid browser input");
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString("utf8");
    const { chromium } = await import("playwright-core");
    const output = await runBrowser(chromium, JSON.parse(input));
    process.stdout.write(JSON.stringify(output));
  } catch {
    // Driver errors can contain arguments and URLs from a private browser operation.
    process.stdout.write(JSON.stringify({ error: "The protected browser operation failed." }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
