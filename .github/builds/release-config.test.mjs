import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mobileReleaseConfig, releaseIdentifier, releaseServer } from "./release-config.mjs";

test("Windows releases validate their application settings without signing credentials", () => {
  const script = fileURLToPath(new URL("./release-config.mjs", import.meta.url));
  const env = {
    BOTONE_DESKTOP_APP_ID: "work.example.desktop",
    EXPO_PUBLIC_API_URL: "https://app.example.com",
  };
  const valid = spawnSync(process.execPath, [script, "windows"], { env, encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  for (const name of Object.keys(env)) {
    const invalid = spawnSync(process.execPath, [script, "windows"], {
      env: { ...env, [name]: "" },
      encoding: "utf8",
    });
    assert.notEqual(invalid.status, 0);
  }
});

test("release configuration rejects credential-bearing and non-origin server addresses", () => {
  assert.equal(releaseServer("https://app.example.com/"), "https://app.example.com");
  for (const value of [
    undefined,
    "http://app.example.com",
    "https://user:password@app.example.com",
    "https://app.example.com/private",
    "https://app.example.com?token=secret",
    "https://app.example.com/#fragment",
  ]) {
    assert.throws(() => releaseServer(value));
  }
});

test("mobile releases isolate updates, push registration, application IDs and sharing groups", () => {
  const source = JSON.parse(readFileSync(new URL("../../apps/mobile/app.json", import.meta.url)));
  const original = structuredClone(source);
  const result = mobileReleaseConfig(source, "work.example.bot", "42").expo;
  assert.deepEqual(source, original);
  assert.equal(result.owner, undefined);
  assert.equal(result.extra.eas, undefined);
  assert.deepEqual(result.updates, { enabled: false });
  assert.equal(result.ios.bundleIdentifier, "work.example.bot");
  assert.equal(result.android.package, "work.example.bot");
  assert.equal(result.ios.buildNumber, "42");
  assert.equal(result.android.versionCode, 42);
  assert.equal(result.scheme, source.expo.scheme);
  assert.equal(
    result.plugins.find((entry) => Array.isArray(entry) && entry[0] === "expo-sharing")[1].ios
      .appGroupId,
    "group.work.example.bot",
  );
  for (const value of ["", "0", "-1", "001", "2100000001", "1; unsafe"]) {
    assert.throws(() => mobileReleaseConfig(source, "work.example.bot", value));
  }
  for (const value of [undefined, "", "com..example", "not-an-id", "com.example\nunsafe"]) {
    assert.throws(() => releaseIdentifier(value));
  }
});

test("desktop release signing cannot silently degrade or inherit upstream updates", () => {
  const previous = { ...process.env };
  try {
    process.env.BOTONE_DESKTOP_APP_ID = "work.example.desktop";
    process.env.EXPO_PUBLIC_API_URL = "https://app.example.com";
    const require = createRequire(import.meta.url);
    const config = require("./desktop-release.cjs");
    assert.equal(config.forceCodeSigning, true);
    assert.equal(config.mac.notarize, true);
    assert.equal(config.mac.hardenedRuntime, true);
    assert.equal(config.publish, null);
    assert.equal(config.appId, "work.example.desktop");
    assert.equal(config.extraMetadata.defaultServerUrl, "https://app.example.com");
    assert.equal(config.productName, "BotONE");
    assert.equal(
      config.mac.extraResources.some((item) => item.to === "server-bundle.json"),
      false,
    );
  } finally {
    process.env = previous;
  }
});
