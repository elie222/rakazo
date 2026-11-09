// Added tests for Mola sandbox provider
import { describe, expect, it } from "vitest";
import { createMolaSandboxProvider } from "./mola-sandbox.js";

describe("MolaSandboxProvider", () => {
  it("constructs with API key and default URL", () => {
    const provider = createMolaSandboxProvider({ apiKey: "test-key" });
    expect(provider).toBeDefined();
    const descriptor = provider.describe();
    expect(descriptor.id).toBe("mola");
  });

  it("constructs with API key and custom URL", () => {
    const provider = createMolaSandboxProvider({
      apiKey: "test-key",
      apiUrl: "http://localhost:4141/v1",
    });
    expect(provider).toBeDefined();
    const descriptor = provider.describe();
    expect(descriptor.id).toBe("mola");
    expect(descriptor.capabilities.graphical).toBe(true);
  });

  it("describes capabilities correctly", () => {
    const provider = createMolaSandboxProvider({ apiKey: "test-key" });
    const descriptor = provider.describe();
    expect(descriptor.capabilities).toEqual({
      graphical: true,
      pty: false,
      snapshots: false,
      takeover: true,
      persistentHome: false,
      multiScreen: false,
    });
  });

  it("does not bill while running by default", () => {
    const provider = createMolaSandboxProvider({ apiKey: "test-key" });
    expect(provider.billsWhileRunning({ kind: "mola" })).toBe(false);
  });
});
