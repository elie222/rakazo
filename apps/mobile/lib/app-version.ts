import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { Platform } from "react-native";

export type AppUpdateIdentity =
  | { kind: "embedded" }
  | {
      kind: "ota";
      /** Short hex fragment of the running update id. */
      id: string;
      channel: string | null;
      /** ISO date (YYYY-MM-DD) when the update was created, if known. */
      createdAt: string | null;
    };

export type AppVersionInfo = {
  /** Store / native binary version, e.g. `1.0.3 (10)`. */
  nativeLabel: string | null;
  update: AppUpdateIdentity;
};

type Translate = (message: string, values?: Record<string, string | number>) => string;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fallbackNativeVersion(): { version: string | null; build: string | null } {
  const version = readString(Constants.expoConfig?.version);
  if (Platform.OS === "ios") {
    return { version, build: readString(Constants.platform?.ios?.buildNumber) };
  }
  if (Platform.OS === "android") {
    const code = Constants.platform?.android?.versionCode;
    return { version, build: code != null ? String(code) : null };
  }
  return { version, build: null };
}

/** Format store version + build as `1.0.3 (10)`, or either part alone. */
export function formatNativeVersionLabel(
  applicationVersion: string | null | undefined,
  buildVersion: string | null | undefined,
): string | null {
  const version = readString(applicationVersion);
  const build = readString(buildVersion);
  if (version && build) return `${version} (${build})`;
  return version ?? build;
}

/** Shorten a UUID update id for footer display. */
export function shortUpdateId(updateId: string): string {
  const compact = updateId.replace(/-/g, "").toLowerCase();
  return compact.slice(0, 8) || updateId.slice(0, 8);
}

function formatCreatedAt(value: unknown): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

function resolveUpdateIdentity(): AppUpdateIdentity {
  try {
    if (!Updates.isEnabled || Updates.isEmbeddedLaunch) return { kind: "embedded" };
    const rawId = readString(Updates.updateId);
    if (!rawId) return { kind: "embedded" };
    return {
      kind: "ota",
      id: shortUpdateId(rawId),
      channel: readString(Updates.channel),
      createdAt: formatCreatedAt(Updates.createdAt),
    };
  } catch {
    // Expo Go, web, and some simulators expose a stub that still throws on access.
    return { kind: "embedded" };
  }
}

/** Human update line for the account footer (English source strings for i18n). */
export function formatUpdateLabel(update: AppUpdateIdentity, t: Translate): string {
  if (update.kind === "embedded") return t("Embedded");
  const { id, channel, createdAt } = update;
  if (channel && createdAt) return t("{channel} · {id} · {date}", { channel, id, date: createdAt });
  if (channel) return t("{channel} · {id}", { channel, id });
  if (createdAt) return t("OTA · {id} · {date}", { id, date: createdAt });
  return t("OTA · {id}", { id });
}

/** Read native store version and OTA identity for the account footer. */
export function getAppVersionInfo(): AppVersionInfo {
  let applicationVersion: string | null = null;
  let buildVersion: string | null = null;
  try {
    applicationVersion = readString(Application.nativeApplicationVersion);
    buildVersion = readString(Application.nativeBuildVersion);
  } catch {
    // Hosts without the native module still get the expo config fallback below.
  }
  const fallback = fallbackNativeVersion();
  return {
    nativeLabel: formatNativeVersionLabel(
      applicationVersion ?? fallback.version,
      buildVersion ?? fallback.build,
    ),
    update: resolveUpdateIdentity(),
  };
}
