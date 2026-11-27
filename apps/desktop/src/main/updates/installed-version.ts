import { readFileSync } from "node:fs";
import path from "node:path";

const SHORT_VERSION = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/;

/** The version in an Info.plist, or null when it has none. */
export function plistVersion(plist: string): string | null {
  return SHORT_VERSION.exec(plist)?.[1]?.trim() || null;
}

/**
 * The version of the macOS app bundle this process was launched from, read from disk now.
 * The path stays the launch path even after another install moved the running bundle away.
 */
export function installedBundleVersion(executable = process.execPath): string | null {
  const infoPlist = path.resolve(executable, "../../Info.plist");
  try {
    return plistVersion(readFileSync(infoPlist, "utf8"));
  } catch (error) {
    // A bundle mid-replacement may be missing its Info.plist; treat the version as unknown.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
