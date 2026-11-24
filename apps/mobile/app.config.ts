import type { ConfigContext, ExpoConfig } from "expo/config";

const RELEASE_PROFILES = new Set(["production", "android-apk", "diagnostic"]);
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;
const EXPO_PROJECT_ID = /^[A-Za-z0-9-]+$/;

export default ({ config }: ConfigContext): ExpoConfig => {
  if (RELEASE_PROFILES.has(process.env.EAS_BUILD_PROFILE ?? "")) {
    const apiUrl = process.env.EXPO_PUBLIC_API_URL;
    if (!apiUrl) {
      throw new Error(
        "EXPO_PUBLIC_API_URL must be set in the EAS production environment before building a release.",
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw new Error("EXPO_PUBLIC_API_URL must be a valid URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("EXPO_PUBLIC_API_URL must use HTTPS for production builds.");
    }
  }

  let result = config as ExpoConfig;

  // Self-signed iOS builds use their own bundle id and team. Config plugins derive extension ids
  // from ios.bundleIdentifier, and EAS appExtensions and the share extension's app group follow.
  const ownBundleId = env("RAKAZO_IOS_BUNDLE_ID");
  if (ownBundleId && !BUNDLE_ID.test(ownBundleId)) {
    throw new Error("RAKAZO_IOS_BUNDLE_ID must be a reverse-DNS bundle identifier.");
  }
  const ownTeamId = env("RAKAZO_APPLE_TEAM_ID");
  if (ownTeamId && !APPLE_TEAM_ID.test(ownTeamId)) {
    throw new Error("RAKAZO_APPLE_TEAM_ID must be a 10-character Apple Developer Team ID.");
  }
  const ownProjectId = env("RAKAZO_EXPO_PROJECT_ID");
  if (ownProjectId && !EXPO_PROJECT_ID.test(ownProjectId)) {
    throw new Error("RAKAZO_EXPO_PROJECT_ID must be an Expo project ID.");
  }
  const ownOwner = env("RAKAZO_EXPO_OWNER");

  const prevBundleId = result.ios?.bundleIdentifier;
  const movedOffUpstreamBundle = Boolean(ownBundleId && ownBundleId !== prevBundleId);
  if (ownBundleId || ownTeamId) {
    const appGroup = ownBundleId ? `group.${ownBundleId}` : undefined;
    const rewrittenEas =
      ownBundleId && prevBundleId && appGroup
        ? rewriteEasIosAppExtensions(result.extra, prevBundleId, ownBundleId, appGroup)
        : undefined;
    result = {
      ...result,
      ios: {
        ...result.ios,
        ...(ownBundleId ? { bundleIdentifier: ownBundleId } : {}),
        ...(ownTeamId ? { appleTeamId: ownTeamId } : {}),
      },
      ...(appGroup && result.plugins
        ? {
            plugins: result.plugins.map((plugin) =>
              Array.isArray(plugin) && plugin[0] === "expo-sharing"
                ? [plugin[0], { ...plugin[1], ios: { ...plugin[1]?.ios, appGroupId: appGroup } }]
                : plugin,
            ),
          }
        : {}),
      ...(appGroup
        ? {
            extra: {
              ...result.extra,
              iosAppGroup: appGroup,
              ...(rewrittenEas ? { eas: rewrittenEas } : {}),
            },
          }
        : {}),
    };
  }

  // Push tokens and OTA updates belong to an Expo project. Upstream's project has no APNs key for
  // a self-signed bundle id and serves upstream's JS, so either move them onto the build's own
  // project or detach them when building under a different bundle id without an Expo project.
  if (ownProjectId) {
    const { owner: _upstreamOwner, ...withoutOwner } = result;
    result = {
      ...withoutOwner,
      ...(ownOwner ? { owner: ownOwner } : {}),
      extra: { ...result.extra, eas: { ...result.extra?.eas, projectId: ownProjectId } },
      updates: { ...result.updates, url: `https://u.expo.dev/${ownProjectId}` },
    };
  } else {
    if (movedOffUpstreamBundle) {
      result = detachUpstreamExpoProject(result);
    }
    if (ownOwner) {
      result = { ...result, owner: ownOwner };
    }
  }

  const rpId = passkeyRpId(process.env.EXPO_PUBLIC_API_URL);
  if (rpId) {
    // Native passkeys only work for domains the binary is associated with, so the app reads the
    // same list at runtime to hide passkeys on other servers. Developer mode makes a
    // development-signed build fetch the association file itself, for a server on a private
    // network or VPN that Apple's CDN cannot reach.
    const mode = process.env.RAKAZO_PASSKEY_DEVELOPER_MODE === "1" ? "?mode=developer" : "";
    result = {
      ...result,
      ios: {
        ...result.ios,
        associatedDomains: [
          ...(result.ios?.associatedDomains ?? []),
          `webcredentials:${rpId}${mode}`,
        ],
      },
      extra: { ...result.extra, passkeyRpIds: [rpId] },
    };
  }

  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;
  if (googleServicesFile) {
    result = { ...result, android: { ...result.android, googleServicesFile } };
  }

  // Native crash handling autolinks; upload build hooks are optional and require credentials.
  if (process.env.SENTRY_AUTH_TOKEN) {
    result = {
      ...result,
      plugins: [
        ...(result.plugins ?? []),
        [
          "@sentry/react-native/expo",
          {
            organization: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            url: process.env.SENTRY_URL,
            // R8 obfuscates release Java and Kotlin, so upload its mapping to read native stacks.
            experimental_android: {
              enableAndroidGradlePlugin: true,
              autoUploadProguardMapping: true,
              uploadNativeSymbols: false,
              includeNativeSources: false,
            },
          },
        ],
      ],
    };
  }
  return result;
};

/** The default server's host when native passkeys can use it: HTTPS and a domain name. */
function passkeyRpId(apiUrl: string | undefined): string | null {
  let url: URL;
  try {
    url = new URL(apiUrl ?? "");
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !host.includes(".")) return null;
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return null;
  return host;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/** Moves EAS's iOS extension bundle IDs and share app group onto a self-signed bundle ID. */
function rewriteEasIosAppExtensions(
  extra: Record<string, unknown> | undefined,
  prevBundleId: string,
  ownBundleId: string,
  appGroup: string,
): Record<string, unknown> | undefined {
  const eas = asRecord(extra?.eas);
  const build = asRecord(eas?.build);
  const experimental = asRecord(build?.experimental);
  const ios = asRecord(experimental?.ios);
  if (!eas || !build || !experimental || !ios || !Array.isArray(ios.appExtensions)) {
    return undefined;
  }
  const prevPrefix = `${prevBundleId}.`;
  const prevAppGroup = `group.${prevBundleId}`;
  const appExtensions = ios.appExtensions.map((entry) => {
    const ext = asRecord(entry);
    if (!ext) return entry;
    const bundleIdentifier =
      typeof ext.bundleIdentifier === "string" && ext.bundleIdentifier.startsWith(prevPrefix)
        ? `${ownBundleId}${ext.bundleIdentifier.slice(prevBundleId.length)}`
        : ext.bundleIdentifier;
    const entitlements = asRecord(ext.entitlements);
    const groups = entitlements?.["com.apple.security.application-groups"];
    const nextEntitlements =
      entitlements && Array.isArray(groups)
        ? {
            ...entitlements,
            "com.apple.security.application-groups": groups.map((group) =>
              group === prevAppGroup ? appGroup : group,
            ),
          }
        : ext.entitlements;
    return {
      ...ext,
      ...(bundleIdentifier !== undefined ? { bundleIdentifier } : {}),
      ...(nextEntitlements !== undefined ? { entitlements: nextEntitlements } : {}),
    };
  });
  return {
    ...eas,
    build: {
      ...build,
      experimental: {
        ...experimental,
        ios: {
          ...ios,
          appExtensions,
        },
      },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Keeps a self-signed build without its own Expo project off upstream's pushes and OTA channel. */
function detachUpstreamExpoProject(config: ExpoConfig): ExpoConfig {
  const { owner: _owner, ...withoutOwner } = config;
  const eas = asRecord(config.extra?.eas);
  let nextExtra = config.extra;
  if (eas && "projectId" in eas) {
    const { projectId: _projectId, ...restEas } = eas;
    const { eas: _eas, ...restExtra } = config.extra ?? {};
    nextExtra = Object.keys(restEas).length > 0 ? { ...restExtra, eas: restEas } : restExtra;
  }
  let nextUpdates = config.updates;
  if (config.updates) {
    const { url: _url, ...restUpdates } = config.updates;
    nextUpdates = { ...restUpdates, enabled: false };
  }
  return {
    ...withoutOwner,
    ...(nextExtra !== undefined ? { extra: nextExtra } : {}),
    ...(nextUpdates !== undefined ? { updates: nextUpdates } : {}),
  };
}
