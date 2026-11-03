import { E2B_COMPUTER_TEMPLATE, E2B_DESKTOP_TEMPLATE } from "./e2b-template.js";
import type { RemoteDesktopSdk } from "./remote-desktop-sandbox.js";
import { RemoteDesktopSandboxProvider } from "./remote-desktop-sandbox.js";

export type {
  RemoteDesktop as E2BDesktop,
  RemoteDesktopSdk as E2BSandboxSdk,
} from "./remote-desktop-sandbox.js";
export {
  keepingAwake,
  remoteDesktopCreateOptions as e2bCreateOptions,
} from "./remote-desktop-sandbox.js";

/** The SDK loads only when an E2B computer is used, never in the default runtime. */
const e2b = async () => (await import("@e2b/desktop")).Sandbox;

const e2bSdk: RemoteDesktopSdk = {
  create: async (template, options) => (await e2b()).create(template, options),
  connect: async (id, options) => (await e2b()).connect(id, options),
  isRunning: async (id, options) => (await (await e2b()).getInfo(id, options)).state === "running",
  pause: async (id, options) => (await e2b()).pause(id, options),
  kill: async (id, options) => (await e2b()).kill(id, options),
};

export class E2BSandboxProvider extends RemoteDesktopSandboxProvider {
  constructor(apiKey: string, sdk: RemoteDesktopSdk = e2bSdk) {
    super({
      id: "e2b",
      label: "E2B",
      apiKey,
      sdk,
      template: E2B_COMPUTER_TEMPLATE,
      fallbackTemplate: E2B_DESKTOP_TEMPLATE,
      isTimeoutError: (error) => error instanceof Error && error.name === "TimeoutError",
    });
  }
}
