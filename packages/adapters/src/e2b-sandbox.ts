import { Sandbox, TimeoutError } from "@e2b/desktop";
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

const e2bSdk: RemoteDesktopSdk = {
  create: (template, options) => Sandbox.create(template, options),
  connect: (id, options) => Sandbox.connect(id, options),
  pause: (id, options) => Sandbox.pause(id, options),
  kill: (id, options) => Sandbox.kill(id, options),
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
      isTimeoutError: (error) => error instanceof TimeoutError,
    });
  }
}
