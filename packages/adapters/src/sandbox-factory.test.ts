import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_SANDBOX_MESSAGE } from "./none-sandbox.js";

const daytonaCtor = vi.fn();

vi.mock("./daytona-sandbox.js", () => ({
  DaytonaSandboxProvider: class {
    constructor(config: unknown) {
      daytonaCtor(config);
    }
    describe() {
      return {
        id: "daytona",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: {},
      };
    }
  },
}));

const { createSandboxProvider } = await import("./sandbox-factory.js");

const ctx = {
  operationId: "op",
  traceId: "tr",
  spaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

describe("createSandboxProvider", () => {
  beforeEach(() => {
    daytonaCtor.mockClear();
  });

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

  it("returns provider-specific managed sandbox emulators", () => {
    expect(createSandboxProvider("e2b-emulator", {}).describe().id).toBe("e2b-emulator");
    expect(createSandboxProvider("daytona-emulator", {}).describe().id).toBe("daytona-emulator");
    expect(createSandboxProvider("box-emulator", {}).describe()).toMatchObject({
      id: "box-emulator",
      capabilities: { multiScreen: true },
    });
  });

  it("boots without a remote key and keeps computers unavailable", async () => {
    expect(createSandboxProvider("e2b", {}).describe().id).toBe("none");
    expect(createSandboxProvider("daytona", {}).describe().id).toBe("none");
    expect(createSandboxProvider("box", {}).describe().id).toBe("none");
    await expect(
      createSandboxProvider("e2b", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(/E2B_API_KEY/);
    expect(createSandboxProvider("box", { boxApiKey: "test-box-key" }).describe().id).toBe("box");
  });

  it("passes daytonaSnapshot through to the Daytona provider", () => {
    const provider = createSandboxProvider("daytona", {
      daytonaApiKey: "test-daytona-key",
      daytonaApiUrl: "https://daytona.test/api",
      daytonaTarget: "test-target",
      daytonaSnapshot: "rakazo-computer",
    });
    expect(provider.describe().id).toBe("daytona");
    expect(daytonaCtor).toHaveBeenCalledWith({
      apiKey: "test-daytona-key",
      apiUrl: "https://daytona.test/api",
      target: "test-target",
      snapshot: "rakazo-computer",
    });
  });

  it("throws on unknown provider", () => {
    expect(() => createSandboxProvider("bogus", {})).toThrow(
      'Unknown SANDBOX_PROVIDER "bogus". Use none | docker | e2b | daytona | box | e2b-emulator | daytona-emulator | box-emulator | desktop | fake.',
    );
  });
});
