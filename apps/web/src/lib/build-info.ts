import type { BuildIdentity, ClientKind } from "@rakazo/core";

declare const __RAKAZO_VERSION__: string;
declare const __RAKAZO_REVISION__: string;

/**
 * Vite replaces these at build time. `vitest` loads the sources without that pass, so the guards
 * keep the fallbacks out of the shipped bundle while still letting tests import this module.
 */
export const buildIdentity: BuildIdentity = {
  version: typeof __RAKAZO_VERSION__ === "string" ? __RAKAZO_VERSION__ : "0.0.0",
  revision:
    typeof __RAKAZO_REVISION__ === "string" && __RAKAZO_REVISION__ !== ""
      ? __RAKAZO_REVISION__
      : null,
};

/**
 * A packaged desktop build serves the renderer it was installed with, so it can genuinely be older
 * or newer than the server. A browser tab always loaded its assets from the server it talks to.
 */
export function clientKind(isDesktop: boolean): ClientKind {
  return isDesktop ? "desktop" : "browser";
}
