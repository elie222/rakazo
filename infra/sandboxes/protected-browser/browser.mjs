import { pathToFileURL } from "node:url";
import { startEgressRelay } from "./egress.mjs";

class SignInRejectedError extends Error {}

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
    if (
      !["click", "fill", "wait"].includes(step.kind) ||
      !(ROLES.has(step.role) || (step.kind === "wait" && step.role === "heading"))
    ) {
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
  if (step.kind === "wait") {
    await control.waitFor({ state: "visible", timeout: TIMEOUT });
    if (
      loginOrigin &&
      (await control.evaluate((element) => element.ownerDocument.location.origin)) !== loginOrigin
    ) {
      throw new SignInRejectedError("Unexpected sign-in origin");
    }
    return;
  }
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
  const field = await (step.role === "textbox"
    ? control.or(
        page.getByLabel(step.name, { exact: true }).and(page.locator('input[type="password"]')),
      )
    : control
  ).elementHandle({ timeout: TIMEOUT });
  try {
    const frame = await field.ownerFrame();
    if (!frame || webUrl(frame.url()).origin !== loginOrigin) {
      throw new SignInRejectedError("Unexpected sign-in origin");
    }
    await field.fill(step.text, { timeout: TIMEOUT });
  } finally {
    await field.dispose();
  }
}

export function pageSnapshot(text, states, sessionValues = []) {
  const values = [
    ...sessionValues,
    ...states.flatMap((storage) => [
      ...storage.cookies.map(({ value }) => value),
      ...storage.origins.flatMap(({ localStorage }) => localStorage.map(({ value }) => value)),
    ]),
  ];
  const secrets = new Set();
  while (values.length) {
    const value = values.pop();
    if (typeof value === "string") {
      if (!value || secrets.has(value)) continue;
      secrets.add(value);
      if (!/^\s*(?:\{|\[|")/.test(value)) continue;
      try {
        values.push(JSON.parse(value));
      } catch {
        // Opaque storage values are still redacted as a whole.
      }
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) values.push(child);
    }
  }
  for (const value of [...secrets].sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(value, "[redacted]");
    const escaped = encodeURIComponent(value.toWellFormed());
    if (escaped !== value) text = text.replaceAll(escaped, "[redacted]");
    const encodedFormValue = new URLSearchParams([["v", value]]).toString().slice(2);
    if (encodedFormValue !== value) text = text.replaceAll(encodedFormValue, "[redacted]");
  }
  return text.slice(0, MAX_PAGE);
}

async function sessionValues(page) {
  const values = await Promise.all(
    page.frames().map((frame) =>
      frame.evaluate(() => {
        if (self.origin === "null") return [];
        return Object.values(sessionStorage);
      }),
    ),
  );
  return values.flat();
}

/** One private invocation. The caller keeps storageState on the trusted side of the tool boundary. */
export async function runBrowser(chromium, request, launchOptions = {}) {
  checkInput(request);
  const url = webUrl(request.url);
  const signingIn = request.mode === "sign-in";
  const success = signingIn ? request.steps.at(-1) : undefined;
  if (signingIn && success?.kind !== "wait") {
    throw new SignInRejectedError("Sign-in requires a final success condition");
  }
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
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    if (
      success &&
      (await page.getByRole(success.role, { name: success.name, exact: true }).isVisible())
    ) {
      throw new SignInRejectedError("Sign-in success condition was already visible");
    }
    const initialStorage = signingIn ? null : await context.storageState();
    let initialSessionValues = signingIn ? [] : await sessionValues(page);
    for (const step of request.steps) {
      try {
        await executeStep(page, step, signingIn ? url.origin : undefined);
        if (!signingIn)
          initialSessionValues = initialSessionValues.concat(await sessionValues(page));
      } catch (error) {
        if (signingIn && error instanceof Error && error.name === "TimeoutError") {
          throw new SignInRejectedError("Sign-in step did not complete");
        }
        throw error;
      }
    }
    const storageState = await context.storageState();
    if (!initialStorage) {
      if (new URL(page.url()).origin !== url.origin) {
        throw new SignInRejectedError("Unexpected sign-in origin");
      }
      storageState.origins = storageState.origins.filter((entry) => entry.origin === url.origin);
      storageState.cookies = storageState.cookies.filter(({ domain }) =>
        domain.startsWith(".")
          ? url.hostname === domain.slice(1) || url.hostname.endsWith(domain)
          : url.hostname === domain,
      );
      if (!storageState.cookies.length && !storageState.origins.length) {
        throw new SignInRejectedError("Sign-in produced no reusable browser state");
      }
      return { storageState };
    }
    const snapshot = await page.locator("body").ariaSnapshot({ timeout: TIMEOUT });
    return {
      storageState,
      page: pageSnapshot(
        snapshot,
        [request.storageState, initialStorage, storageState],
        initialSessionValues.concat(await sessionValues(page)),
      ),
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
    if (process.env.PROTECTED_BROWSER_EGRESS !== "1") throw new Error("Missing egress relay");
    const relay = await startEgressRelay();
    try {
      const output = await runBrowser(chromium, JSON.parse(input), relay.launchOptions);
      process.stdout.write(JSON.stringify(output));
    } finally {
      relay.close();
    }
  } catch (error) {
    // Driver errors can contain arguments and URLs from a private browser operation.
    process.stdout.write(JSON.stringify({ error: "The protected browser operation failed." }));
    // The launcher uses this exit status for a rejected sign-in.
    process.exitCode = error instanceof SignInRejectedError ? 10 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
