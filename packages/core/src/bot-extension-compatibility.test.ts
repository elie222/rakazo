import { describe, expect, it } from "vitest";
import {
  type BotExtensionManifest,
  checkBotExtensionCompatibility,
} from "./bot-extension-compatibility.js";

const manifest: BotExtensionManifest = {
  extensionId: "research",
  version: "1.0.0",
  digest: `sha256:${"a".repeat(64)}`,
  hostApiVersion: 1,
  requiredSurfaces: ["tools", "tool-gates"],
  operatorApproved: true,
  withdrawn: false,
};

describe("extension compatibility preflight", () => {
  it("admits an approved compatible pinned artifact only when the host is enabled", () => {
    expect(checkBotExtensionCompatibility(manifest, true)).toEqual({ compatible: true });
    expect(checkBotExtensionCompatibility(manifest, false)).toEqual({
      compatible: false,
      reasons: ["extension-host-disabled"],
    });
  });

  it.each([
    [{ operatorApproved: false }, "operator-approval-required"],
    [{ withdrawn: true }, "artifact-withdrawn"],
    [{ digest: "latest" }, "invalid-artifact-digest"],
    [{ hostApiVersion: 2 }, "unsupported-host-api-version"],
    [{ requiredSurfaces: ["terminal-ui"] }, "unsupported-surface:terminal-ui"],
    [{ requiredSurfaces: ["session-owner"] }, "unsupported-surface:session-owner"],
    [{ requiredSurfaces: ["process-owner"] }, "unsupported-surface:process-owner"],
  ] as const)("rejects unsupported assignment %j", (patch, reason) => {
    expect(checkBotExtensionCompatibility({ ...manifest, ...patch }, true)).toEqual({
      compatible: false,
      reasons: [reason],
    });
  });

  it("reports all activation blockers without executing an artifact", () => {
    const result = checkBotExtensionCompatibility(
      { ...manifest, operatorApproved: false, withdrawn: true },
      false,
    );
    expect(result).toEqual({
      compatible: false,
      reasons: ["extension-host-disabled", "operator-approval-required", "artifact-withdrawn"],
    });
  });
});
