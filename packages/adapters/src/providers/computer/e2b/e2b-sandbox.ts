import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import type {
  RemoteDesktop,
  RemoteDesktopSdk,
} from "../../../computers/sandbox/remote-desktop-sandbox.js";
import { RemoteDesktopSandboxProvider } from "../../../computers/sandbox/remote-desktop-sandbox.js";
import { E2B_COMPUTER_TEMPLATE, E2B_DESKTOP_TEMPLATE } from "./e2b-template.js";

export type {
  RemoteDesktop as E2BDesktop,
  RemoteDesktopSdk as E2BSandboxSdk,
} from "../../../computers/sandbox/remote-desktop-sandbox.js";
export {
  keepingAwake,
  remoteDesktopCreateOptions as e2bCreateOptions,
} from "../../../computers/sandbox/remote-desktop-sandbox.js";

/** The SDK loads only when an E2B computer is used, never in the default runtime. */
const e2b = async () => (await import("@e2b/desktop")).Sandbox;

// The lifecycle and job runner own retries. The SDK's own would stack under them, hold a call open
// through its backoff, and replay a create whose 503 may have started a sandbox. A connected
// sandbox keeps this for its later API calls.
const noRetries = { retries: 0 };

const e2bSdk: RemoteDesktopSdk = {
  create: async (template, options) => (await e2b()).create(template, { ...options, ...noRetries }),
  connect: async (id, options) => (await e2b()).connect(id, { ...options, ...noRetries }),
  isRunning: async (id, options) =>
    (await (await e2b()).getInfo(id, { ...options, ...noRetries })).state === "running",
  pause: async (id, options) => (await e2b()).pause(id, { ...options, ...noRetries }),
  kill: async (id, options) => (await e2b()).kill(id, { ...options, ...noRetries }),
};

/**
 * E2B's rate limit is the computer's rate limit: the calls report it as SandboxRateLimitError with
 * the SDK's error as its cause, so users see the usual message and idle sleep defers. The SDK loads
 * lazily, so the error is matched by its name, as the timeout is.
 */
function withRateLimitErrors(sdk: RemoteDesktopSdk): RemoteDesktopSdk {
  const limited = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw error instanceof Error && error.name === "RateLimitError"
        ? new SandboxRateLimitError({ cause: error })
        : error;
    }
  };
  const wrapDesktop = (desktop: RemoteDesktop): RemoteDesktop => {
    const files = desktop.files;
    const wrappedFiles = {
      makeDir: (...args: Parameters<typeof files.makeDir>) => limited(() => files.makeDir(...args)),
      list: (...args: Parameters<typeof files.list>) => limited(() => files.list(...args)),
      getInfo: (...args: Parameters<typeof files.getInfo>) => limited(() => files.getInfo(...args)),
      read: (...args: Parameters<typeof files.read>) => limited(() => files.read(...args)),
      write: (...args: Parameters<typeof files.write>) => limited(() => files.write(...args)),
    };
    // Keep the desktop's other members (class-instance methods on its prototype) by delegating
    // through the prototype chain instead of spreading, which would drop them.
    return Object.create(desktop, {
      files: { value: wrappedFiles, writable: true, configurable: true },
    }) as RemoteDesktop;
  };
  const { isRunning } = sdk;
  return {
    ...sdk,
    create: (...args) => limited(() => sdk.create(...args)).then(wrapDesktop),
    connect: (...args) => limited(() => sdk.connect(...args)).then(wrapDesktop),
    pause: (...args) => limited(() => sdk.pause(...args)),
    kill: (...args) => limited(() => sdk.kill(...args)),
    ...(isRunning && { isRunning: (...args) => limited(() => isRunning(...args)) }),
  };
}

export class E2BSandboxProvider extends RemoteDesktopSandboxProvider {
  constructor(apiKey: string, sdk: RemoteDesktopSdk = e2bSdk) {
    super({
      id: "e2b",
      // Restricted sandboxes require this header.
      trafficAccessHeader: "e2b-traffic-access-token",
      label: "E2B",
      apiKey,
      sdk: withRateLimitErrors(sdk),
      template: E2B_COMPUTER_TEMPLATE,
      fallbackTemplate: E2B_DESKTOP_TEMPLATE,
      isTimeoutError: (error) => error instanceof Error && error.name === "TimeoutError",
    });
  }
}
