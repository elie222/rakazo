import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyOptimizedRules } from "./with-android-r8.js";

const require = createRequire(import.meta.url);
const expoTemplateTgz = join(dirname(require.resolve("expo/package.json")), "template.tgz");
// The plugin matches exact Expo build.gradle text. Read the pinned package's
// prebuild template so a patch bump fails here instead of at Android prebuild.
const TEMPLATE = execFileSync(
  "tar",
  ["-xOf", expoTemplateTgz, "package/android/app/build.gradle"],
  {
    encoding: "utf8",
  },
);

describe("applyOptimizedRules", () => {
  it("lets R8 optimize release code", () => {
    const result = applyOptimizedRules(TEMPLATE);

    expect(result).toContain(
      'proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"',
    );
    expect(result).not.toContain('"proguard-android.txt"');
    // Minification itself stays behind the template's property, which the plugin sets.
    expect(result).toContain("minifyEnabled enableMinifyInReleaseBuilds");
  });

  it("is idempotent", () => {
    const once = applyOptimizedRules(TEMPLATE);
    expect(applyOptimizedRules(once)).toBe(once);
  });

  it("fails loudly when the Expo template drifts", () => {
    expect(() => applyOptimizedRules("android {}")).toThrow(/default ProGuard file/);
  });
});
