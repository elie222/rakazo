import { FakeBrowserProvider, type FakeBrowserProviderOptions } from "./fake-browser.js";

/**
 * Offline emulator for the page-browser adapter slot. Same behavior as fake;
 * distinct id so conformance can cover the emulator path without a hosted
 * browser vendor or Playwright/Puppeteer product dependency.
 */
export class EmulatorBrowserProvider extends FakeBrowserProvider {
  constructor(options: FakeBrowserProviderOptions = {}) {
    super(options);
  }

  override describe() {
    return {
      ...super.describe(),
      id: "emulator",
    };
  }
}
