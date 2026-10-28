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
    expect(createSandboxProvider("novita", {}).describe().id).toBe("none");
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

  it("returns the Kubernetes provider without contacting the cluster", () => {
    const sandbox = createSandboxProvider("kubernetes", {
      kubernetesNamespace: "rakazo-computers",
      kubernetesRuntimeClassName: "kata",
    });
    expect(sandbox.describe()).toMatchObject({
      id: "kubernetes",
      capabilities: { graphical: true, pty: true, persistentHome: false },
    });
  });

  it("selects Novita without using E2B credentials", async () => {
    expect(
      createSandboxProvider("novita", { novitaApiKey: "test-novita-key" }).describe(),
    ).toMatchObject({
      id: "novita",
      capabilities: { graphical: true, persistentHome: true, multiScreen: true },
    });
    await expect(
      createSandboxProvider("novita", { e2bApiKey: "test-e2b-key" }).provision(
        { botId: "b", homePath: "/unused" },
        ctx,
      ),
    ).rejects.toThrow(/NOVITA_API_KEY/);
  });

  it("throws on unknown provider", () => {
    expect(() => createSandboxProvider("bogus", {})).toThrow(
      'Unknown SANDBOX_PROVIDER "bogus". Use none | docker | e2b | novita | daytona | createos | boat | railway | kubernetes | desktop | fake.',
    );
  });
});
