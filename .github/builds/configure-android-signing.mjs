// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: CI packaging runs directly, outside Turbo.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const keystore = path.join(process.env.RUNNER_TEMP, "botone-release.jks");
writeFileSync(keystore, Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, "base64"), {
  mode: 0o600,
});
execFileSync(
  "keytool",
  [
    "-list",
    "-keystore",
    keystore,
    "-storepass:env",
    "ANDROID_KEYSTORE_PASSWORD",
    "-alias",
    process.env.ANDROID_KEY_ALIAS,
  ],
  { stdio: "pipe" },
);
const file = "apps/mobile/android/app/build.gradle";
let source = readFileSync(file, "utf8");
const marker = "signingConfig signingConfigs.debug";
// The generated file contains one debug and one release reference.
const release = source.indexOf("release {", source.indexOf("buildTypes"));
const before = source.slice(0, release);
const after = source.slice(release);
if (release < 0 || !after.includes(marker) || !source.includes("signingConfigs {")) {
  throw new Error("Expo's generated release signing configuration has changed.");
}
source = before + after.replace(marker, "signingConfig signingConfigs.botoneRelease");
source = source.replace(
  "signingConfigs {",
  `signingConfigs {
        botoneRelease {
            storeFile file(System.getenv("BOTONE_KEYSTORE_PATH"))
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD")
        }`,
);
writeFileSync(file, source);
writeFileSync(process.env.GITHUB_ENV, `BOTONE_KEYSTORE_PATH=${keystore}\n`, { flag: "a" });
