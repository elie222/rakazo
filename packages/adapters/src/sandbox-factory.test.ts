import { describe, expect, it } from "vitest";
import { createSandboxProvider } from "./sandbox-factory.js";

describe("createSandboxProvider", () => {
  it("returns fake sandbox when explicitly requested", () => {
    const sandbox = createSandboxProvider("fake", {});
    expect(sandbox.describe().id).toBe("fake");
  });

  it("returns provider-specific managed sandbox emulators", () => {
    expect(createSandboxProvider("e2b-emulator", {}).describe().id).toBe("e2b-emulator");
    expect(createSandboxProvider("daytona-emulator", {}).describe().id).toBe("daytona-emulator");
    expect(createSandboxProvider("box-emulator", {}).describe()).toMatchObject({
      id: "box-emulator",
      capabilities: { multiScreen: false },
    });
  });

  it("requires provider-specific credentials", () => {
    expect(() => createSandboxProvider("e2b", {})).toThrow(/E2B_API_KEY/);
    expect(() => createSandboxProvider("daytona", {})).toThrow(/DAYTONA_API_KEY/);
    expect(() => createSandboxProvider("box", {})).toThrow(/BOX_API_KEY/);
    expect(createSandboxProvider("box", { boxApiKey: "test-box-key" }).describe().id).toBe("box");
  });

  it("throws on unknown provider", () => {
    expect(() => createSandboxProvider("bogus", {})).toThrow(
      'Unknown SANDBOX_PROVIDER "bogus". Use docker | e2b | daytona | box | e2b-emulator | daytona-emulator | box-emulator | desktop | fake.',
    );
  });
});
