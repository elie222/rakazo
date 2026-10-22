import { describe, expect, it, vi } from "vitest";
import { NO_SANDBOX_MESSAGE } from "./none-sandbox.js";
import { createSandboxProvider } from "./sandbox-factory.js";

const ctx = {
  operationId: "op",
  traceId: "tr",
  spaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

describe("createSandboxProvider", () => {
  it("returns fake sandbox when explicitly requested", () => {
    const sandbox = createSandboxProvider("fake", {});
    expect(sandbox.describe().id).toBe("fake");
  });

  it("returns none when requested or when the kind is empty", async () => {
    expect(createSandboxProvider("none", {}).describe().id).toBe("none");
    expect(createSandboxProvider("", {}).describe().id).toBe("none");
    await expect(
      createSandboxProvider("none", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(NO_SANDBOX_MESSAGE);
  });

  it("boots without a remote key and keeps computers unavailable", async () => {
    expect(createSandboxProvider("e2b", {}).describe().id).toBe("none");
    expect(createSandboxProvider("daytona", {}).describe().id).toBe("none");
    expect(createSandboxProvider("createos", {}).describe().id).toBe("none");
    expect(createSandboxProvider("boat", {}).describe().id).toBe("none");
    await expect(
      createSandboxProvider("e2b", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(/E2B_API_KEY/);
    await expect(
      createSandboxProvider("createos", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(/CREATEOS_SANDBOX_API_KEY/);
    expect(
      createSandboxProvider("createos", { createosApiKey: "test-createos-key" }).describe().id,
    ).toBe("createos");
    expect(createSandboxProvider("boat", { boatApiKey: "test-boat-key" }).describe().id).toBe(
      "boat",
    );
  });

  it("refuses the desktop provider in a production server process", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => createSandboxProvider("desktop", {})).toThrow(
        "SANDBOX_PROVIDER=desktop runs bot commands directly on this host",
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(createSandboxProvider("desktop", {}).describe().id).toBe("desktop");
  });

  it("throws on unknown provider", () => {
    expect(() => createSandboxProvider("bogus", {})).toThrow(
      'Unknown SANDBOX_PROVIDER "bogus". Use none | docker | e2b | daytona | createos | boat | railway | desktop | fake.',
    );
  });
});
