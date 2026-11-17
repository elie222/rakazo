import { createRequire } from "node:module";

/**
 * Electron downloads its binary on first require. Do it before the tests so the download
 * does not spend the first test's timeout.
 */
export default function downloadElectronBinary() {
  createRequire(import.meta.url)("electron");
}
