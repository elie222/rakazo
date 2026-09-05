import type { BrowserProvider, SandboxProvider } from "@rakazo/adapter-kit";
import { EmulatorBrowserProvider } from "./browser-emulator.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { FakeBrowserProvider, type FakeBrowserProviderOptions } from "./fake-browser.js";

export type CreateBrowserProviderOptions = FakeBrowserProviderOptions & {
  sandbox?: SandboxProvider;
};

/**
 * Resolve the deployment page-browser provider.
 *
 * Production default is always `computer` (live CDP on the bot computer via
 * ComputerBrowserProvider). Fake and emulator are selected only when
 * BROWSER_PROVIDER=fake or emulator for offline conformance. Real computers
 * never report detached DOM success; they use the live page path or return
 * computer_act fallback. This slot is not Playwright/Puppeteer as a product.
 */
export function resolveBrowserProviderKind(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source.BROWSER_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "computer" || raw === "sandbox") return "computer";
  if (raw === "fake") return "fake";
  if (raw === "emulator") return "emulator";
  return raw;
}

export function createBrowserProvider(
  kind?: string,
  options?: CreateBrowserProviderOptions,
): BrowserProvider {
  const resolved = (kind ?? resolveBrowserProviderKind()).trim() || resolveBrowserProviderKind();
  switch (resolved) {
    case "computer":
    case "sandbox":
    case "":
      return new ComputerBrowserProvider(options);
    case "fake":
      return new FakeBrowserProvider(options);
    case "emulator":
      return new EmulatorBrowserProvider(options);
    default:
      throw new Error(`Unknown browser provider "${resolved}"`);
  }
}
