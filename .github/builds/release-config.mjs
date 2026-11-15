// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: CI packaging runs directly, outside Turbo.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseIdentifier(value) {
  if (!value || !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(value)) {
    throw new Error("Configure a valid application ID repository variable.");
  }
  return value;
}

export function releaseServer(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("EXPO_PUBLIC_API_URL must be an HTTPS origin without credentials.");
  }
  return url.origin;
}

export function mobileReleaseConfig(source, identifier, number) {
  releaseIdentifier(identifier);
  if (!/^[1-9]\d*$/.test(number) || Number(number) > 2_100_000_000) {
    throw new Error("Use a positive build number no greater than 2100000000.");
  }
  const result = structuredClone(source);
  const app = result.expo;
  delete app.owner;
  delete app.extra.eas;
  app.slug = "botone";
  app.updates = { enabled: false };
  app.ios.bundleIdentifier = identifier;
  app.ios.buildNumber = number;
  app.android.package = identifier;
  app.android.versionCode = Number(number);
  delete app.android.googleServicesFile;
  for (const plugin of app.plugins) {
    if (Array.isArray(plugin) && plugin[0] === "expo-sharing") {
      plugin[1].ios.appGroupId = `group.${identifier}`;
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const platform = process.argv[2];
  const url = releaseServer(process.env.EXPO_PUBLIC_API_URL);
  // Repository variables are not automatically masked like secrets.
  for (const value of [url, new URL(url).host]) console.log(`::add-mask::${value}`);
  releaseIdentifier(
    process.env[
      platform === "ios" || platform === "android"
        ? "BOTONE_MOBILE_APP_ID"
        : "BOTONE_DESKTOP_APP_ID"
    ],
  );
  const required = {
    ios: [
      "APPLE_TEAM_ID",
      "IOS_DISTRIBUTION_P12_BASE64",
      "IOS_DISTRIBUTION_P12_PASSWORD",
      "IOS_MAIN_PROFILE_BASE64",
      "IOS_WIDGET_PROFILE_BASE64",
      "IOS_SHARE_PROFILE_BASE64",
      "IOS_NOTIFICATION_PROFILE_BASE64",
    ],
    macos: [
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
      "APP_STORE_CONNECT_API_KEY_BASE64",
    ],
    android: [
      "ANDROID_KEYSTORE_BASE64",
      "ANDROID_KEYSTORE_PASSWORD",
      "ANDROID_KEY_ALIAS",
      "ANDROID_KEY_PASSWORD",
    ],
    windows: [],
  }[platform];
  if (!required) throw new Error("Unknown release platform.");
  for (const name of required) {
    if (!process.env[name]?.trim()) throw new Error(`Missing repository secret: ${name}`);
  }
  if (platform === "ios" || platform === "android") {
    const file = new URL("../../apps/mobile/app.json", import.meta.url);
    const source = JSON.parse(readFileSync(file, "utf8"));
    const result = mobileReleaseConfig(
      source,
      process.env.BOTONE_MOBILE_APP_ID,
      process.env.BUILD_NUMBER,
    );
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  }
}
