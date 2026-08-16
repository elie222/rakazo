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
  });

  it("requires provider-specific credentials", () => {
    expect(() => createSandboxProvider("e2b", {})).toThrow(/E2B_API_KEY/);
    expect(() => createSandboxProvider("daytona", {})).toThrow(/DAYTONA_API_KEY/);
  });

  it("throws on unknown provider", () => {
    expect(() => createSandboxProvider("bogus", {})).toThrow(
      'Unknown SANDBOX_PROVIDER "bogus". Use docker | e2b | daytona | e2b-emulator | daytona-emulator | desktop | fake.',
    );
  });
});
