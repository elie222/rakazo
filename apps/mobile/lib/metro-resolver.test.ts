import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { resolveTypeScriptSource } = require("../metro-resolver.js") as {
  resolveTypeScriptSource: (
    context: { originModulePath?: string },
    moduleName: string,
    platform: string,
    resolveRequest: (
      context: { originModulePath?: string },
      moduleName: string,
      platform: string,
    ) => unknown,
  ) => unknown;
};

describe("mobile Metro resolver", () => {
  it("resolves Node ESM-style JavaScript specifiers to TypeScript source", () => {
    const resolved = { type: "sourceFile", filePath: "/repo/packages/core/src/async.ts" };
    const resolveRequest = vi.fn((_context, moduleName: string) => {
      if (moduleName === "./async") return resolved;
      throw new Error(`Unexpected module: ${moduleName}`);
    });

    expect(
      resolveTypeScriptSource(
        { originModulePath: "/repo/packages/core/src/index.ts" },
        "./async.js",
        "ios",
        resolveRequest,
      ),
    ).toEqual(resolved);
    expect(resolveRequest).toHaveBeenCalledWith(
      { originModulePath: "/repo/packages/core/src/index.ts" },
      "./async",
      "ios",
    );
  });

  it("keeps ordinary JavaScript imports on Metro's normal path", () => {
    const resolved = { type: "sourceFile", filePath: "/repo/app/helper.js" };
    const resolveRequest = vi.fn(() => resolved);
    const context = { originModulePath: "/repo/app/index.js" };

    expect(resolveTypeScriptSource(context, "./helper.js", "ios", resolveRequest)).toEqual(
      resolved,
    );
    expect(resolveRequest).toHaveBeenCalledOnce();
    expect(resolveRequest).toHaveBeenCalledWith(context, "./helper.js", "ios");
  });
});
