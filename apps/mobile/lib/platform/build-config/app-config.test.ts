import type { ConfigContext, ExpoConfig } from "expo/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import appConfig from "../../../app.config";

beforeEach(() => {
  vi.stubEnv("EAS_BUILD_PROFILE", "production");
  vi.stubEnv("EXPO_PUBLIC_API_URL", "https://app.example.com");
  vi.stubEnv("RAKAZO_IOS_BUNDLE_ID", undefined);
  vi.stubEnv("RAKAZO_APPLE_TEAM_ID", undefined);
  vi.stubEnv("RAKAZO_EXPO_PROJECT_ID", undefined);
  vi.stubEnv("RAKAZO_EXPO_OWNER", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const config: ExpoConfig = {
  name: "Example",
  slug: "example",
  android: { package: "com.example.app", permissions: ["POST_NOTIFICATIONS"] },
  ios: { bundleIdentifier: "com.example.app" },
  extra: { example: true },
};

function context(config: ExpoConfig): ConfigContext {
  return { config, projectRoot: "/project", staticConfigPath: null, packageJsonPath: null };
}

const passkeys = {
  ios: { ...config.ios, associatedDomains: ["webcredentials:app.example.com"] },
  extra: { ...config.extra, passkeyRpIds: ["app.example.com"] },
};

describe("mobile app config", () => {
  it("loads the Firebase file path while preserving the existing config", () => {
    vi.stubEnv("GOOGLE_SERVICES_JSON", "/build/google-services.json");

    expect(appConfig(context(config))).toEqual({
      ...config,
      ...passkeys,
      android: { ...config.android, googleServicesFile: "/build/google-services.json" },
    });
    expect(config.android).not.toHaveProperty("googleServicesFile");
  });

  it("leaves the config unchanged when no variable applies", () => {
    vi.stubEnv("EAS_BUILD_PROFILE", "development");
    vi.stubEnv("EXPO_PUBLIC_API_URL", undefined);
    vi.stubEnv("GOOGLE_SERVICES_JSON", undefined);
    const existing = {
      ...config,
      android: { ...config.android, googleServicesFile: "./custom-google-services.json" },
    };

    expect(appConfig(context(existing))).toBe(existing);
    expect(appConfig(context(config))).toBe(config);
  });

  it("adds Android config when none exists", () => {
    vi.stubEnv("GOOGLE_SERVICES_JSON", "/build/google-services.json");
    const { android: _android, ...withoutAndroid } = config;

    expect(appConfig(context(withoutAndroid))).toEqual({
      ...withoutAndroid,
      ...passkeys,
      android: { googleServicesFile: "/build/google-services.json" },
    });
  });

  it("associates the default server's domain for passkeys and keeps other domains", () => {
    vi.stubEnv("EXPO_PUBLIC_API_URL", "https://App.Example.com:8443/api");
    const existing = { ...config, ios: { ...config.ios, associatedDomains: ["applinks:x.test"] } };

    expect(appConfig(context(existing))).toEqual({
      ...config,
      ios: {
        ...config.ios,
        associatedDomains: ["applinks:x.test", "webcredentials:app.example.com"],
      },
      extra: { ...config.extra, passkeyRpIds: ["app.example.com"] },
    });
  });

  it("asks a development build to fetch the association itself in developer mode", () => {
    vi.stubEnv("EAS_BUILD_PROFILE", "development");
    vi.stubEnv("RAKAZO_PASSKEY_DEVELOPER_MODE", "1");

    expect(appConfig(context(config))).toEqual({
      ...config,
      ios: { ...config.ios, associatedDomains: ["webcredentials:app.example.com?mode=developer"] },
      extra: { ...config.extra, passkeyRpIds: ["app.example.com"] },
    });
  });

  it.each([
    "http://app.example.com",
    "https://localhost:3100",
    "https://192.168.1.20",
    "https://[::1]",
    "not a url",
  ])("skips passkey domains for %s", (url) => {
    vi.stubEnv("EAS_BUILD_PROFILE", "development");
    vi.stubEnv("EXPO_PUBLIC_API_URL", url);
    vi.stubEnv("GOOGLE_SERVICES_JSON", undefined);

    expect(appConfig(context(config))).toBe(config);
  });

  it("moves iOS bundle ID, team ID, share app group, and EAS extensions, and detaches upstream Expo defaults when no project ID is given", () => {
    vi.stubEnv("RAKAZO_IOS_BUNDLE_ID", "com.example.rakazo");
    vi.stubEnv("RAKAZO_APPLE_TEAM_ID", "TEAM123456");
    const upstream: ExpoConfig = {
      ...config,
      owner: "upstream",
      ios: { bundleIdentifier: "com.rakazo.app", supportsTablet: true },
      plugins: [
        "expo-router",
        [
          "expo-sharing",
          {
            ios: { enabled: true, appGroupId: "group.com.rakazo.app" },
            android: { enabled: true },
          },
        ],
      ],
      extra: {
        ...config.extra,
        eas: {
          projectId: "upstream-project",
          build: {
            experimental: {
              ios: {
                appExtensions: [
                  {
                    targetName: "RakazoWidgets",
                    bundleIdentifier: "com.rakazo.app.widgets",
                  },
                  {
                    targetName: "expo-sharing-extension",
                    bundleIdentifier: "com.rakazo.app.expo-sharing-extension",
                    entitlements: {
                      "com.apple.security.application-groups": ["group.com.rakazo.app"],
                    },
                  },
                  {
                    targetName: "OtherExt",
                    bundleIdentifier: "org.other.ext",
                    entitlements: {
                      "com.apple.security.application-groups": ["group.org.other"],
                    },
                  },
                ],
              },
            },
          },
        },
      },
      updates: { url: "https://u.expo.dev/upstream-project", fallbackToCacheTimeout: 0 },
    };

    const actual = appConfig(context(upstream));
    expect(actual).toEqual({
      name: upstream.name,
      slug: upstream.slug,
      android: upstream.android,
      ios: {
        bundleIdentifier: "com.example.rakazo",
        supportsTablet: true,
        appleTeamId: "TEAM123456",
        associatedDomains: ["webcredentials:app.example.com"],
      },
      plugins: [
        "expo-router",
        [
          "expo-sharing",
          {
            ios: { enabled: true, appGroupId: "group.com.example.rakazo" },
            android: { enabled: true },
          },
        ],
      ],
      extra: {
        ...passkeys.extra,
        iosAppGroup: "group.com.example.rakazo",
        eas: {
          build: {
            experimental: {
              ios: {
                appExtensions: [
                  {
                    targetName: "RakazoWidgets",
                    bundleIdentifier: "com.example.rakazo.widgets",
                  },
                  {
                    targetName: "expo-sharing-extension",
                    bundleIdentifier: "com.example.rakazo.expo-sharing-extension",
                    entitlements: {
                      "com.apple.security.application-groups": ["group.com.example.rakazo"],
                    },
                  },
                  {
                    targetName: "OtherExt",
                    bundleIdentifier: "org.other.ext",
                    entitlements: {
                      "com.apple.security.application-groups": ["group.org.other"],
                    },
                  },
                ],
              },
            },
          },
        },
      },
      updates: { enabled: false, fallbackToCacheTimeout: 0 },
    });
    expect(actual).not.toHaveProperty("owner");
    expect(upstream.ios?.bundleIdentifier).toBe("com.rakazo.app");
  });

  it("points push tokens and OTA updates at a self-built app's own Expo project", () => {
    vi.stubEnv("RAKAZO_EXPO_PROJECT_ID", "own-project");
    vi.stubEnv("RAKAZO_EXPO_OWNER", "own-owner");
    const upstream: ExpoConfig = {
      ...config,
      owner: "upstream",
      extra: { ...config.extra, eas: { projectId: "upstream-project", build: { keep: true } } },
      updates: { url: "https://u.expo.dev/upstream-project", fallbackToCacheTimeout: 0 },
    };

    expect(appConfig(context(upstream))).toEqual({
      ...upstream,
      ...passkeys,
      owner: "own-owner",
      extra: {
        ...passkeys.extra,
        eas: { projectId: "own-project", build: { keep: true } },
      },
      updates: { url: "https://u.expo.dev/own-project", fallbackToCacheTimeout: 0 },
    });
  });

  it("drops upstream owner when RAKAZO_EXPO_PROJECT_ID is set without RAKAZO_EXPO_OWNER", () => {
    vi.stubEnv("RAKAZO_EXPO_PROJECT_ID", "own-project");
    const upstream: ExpoConfig = {
      ...config,
      owner: "upstream",
      extra: { ...config.extra, eas: { projectId: "upstream-project" } },
      updates: { url: "https://u.expo.dev/upstream-project" },
    };

    const actual = appConfig(context(upstream));
    expect(actual).toEqual({
      name: upstream.name,
      slug: upstream.slug,
      android: upstream.android,
      ...passkeys,
      extra: {
        ...passkeys.extra,
        eas: { projectId: "own-project" },
      },
      updates: { url: "https://u.expo.dev/own-project" },
    });
    expect(actual).not.toHaveProperty("owner");
  });

  it("combines self-signed iOS bundle and Expo project overrides without clobbering EAS config", () => {
    vi.stubEnv("RAKAZO_IOS_BUNDLE_ID", "com.example.rakazo");
    vi.stubEnv("RAKAZO_EXPO_PROJECT_ID", "own-project");
    const upstream: ExpoConfig = {
      ...config,
      owner: "upstream",
      ios: { bundleIdentifier: "com.rakazo.app" },
      extra: {
        ...config.extra,
        eas: {
          projectId: "upstream-project",
          build: {
            experimental: {
              ios: {
                appExtensions: [
                  {
                    targetName: "AgentNotifications",
                    bundleIdentifier: "com.rakazo.app.notifications",
                  },
                ],
              },
            },
          },
        },
      },
      updates: { url: "https://u.expo.dev/upstream-project" },
    };

    const actual = appConfig(context(upstream));
    expect(actual).toEqual({
      name: upstream.name,
      slug: upstream.slug,
      android: upstream.android,
      ios: {
        bundleIdentifier: "com.example.rakazo",
        associatedDomains: ["webcredentials:app.example.com"],
      },
      extra: {
        ...passkeys.extra,
        iosAppGroup: "group.com.example.rakazo",
        eas: {
          projectId: "own-project",
          build: {
            experimental: {
              ios: {
                appExtensions: [
                  {
                    targetName: "AgentNotifications",
                    bundleIdentifier: "com.example.rakazo.notifications",
                  },
                ],
              },
            },
          },
        },
      },
      updates: { url: "https://u.expo.dev/own-project" },
    });
    expect(actual).not.toHaveProperty("owner");
  });

  it("rejects malformed bundle IDs, team IDs, and Expo project IDs", () => {
    vi.stubEnv("RAKAZO_IOS_BUNDLE_ID", "not a bundle id");
    expect(() => appConfig(context(config))).toThrow(
      "RAKAZO_IOS_BUNDLE_ID must be a reverse-DNS bundle identifier.",
    );

    vi.stubEnv("RAKAZO_IOS_BUNDLE_ID", undefined);
    vi.stubEnv("RAKAZO_APPLE_TEAM_ID", "Team (ABC123)");
    expect(() => appConfig(context(config))).toThrow(
      "RAKAZO_APPLE_TEAM_ID must be a 10-character Apple Developer Team ID.",
    );

    vi.stubEnv("RAKAZO_APPLE_TEAM_ID", undefined);
    vi.stubEnv("RAKAZO_EXPO_PROJECT_ID", "https://u.expo.dev/abc");
    expect(() => appConfig(context(config))).toThrow(
      "RAKAZO_EXPO_PROJECT_ID must be an Expo project ID.",
    );
  });
});
