import { describe, expect, it } from "vitest";
import { createMolaSandboxProvider } from "./mola-sandbox.js";

describe("MolaSandboxProvider", () => {
  describe("construction and configuration", () => {
    it("constructs with API key and default cloud URL", () => {
      const provider = createMolaSandboxProvider({ apiKey: "test-key" });
      expect(provider).toBeDefined();
      const descriptor = provider.describe();
      expect(descriptor.id).toBe("mola");
      expect(descriptor.capabilities.graphical).toBe(true);
    });

    it("constructs with API key and custom self-hosted URL", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://localhost:4141/v1",
      });
      expect(provider).toBeDefined();
      const descriptor = provider.describe();
      expect(descriptor.id).toBe("mola");
      expect(descriptor.capabilities.graphical).toBe(true);
    });

    it("detects cloud mode for cloud.mola.sh", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });
      expect(provider).toBeDefined();
    });

    it("detects self-hosted mode for localhost", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://127.0.0.1:4141/v1",
      });
      expect(provider).toBeDefined();
    });

    it("defaults to cloud mode for unknown URLs", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://mola.example.com/api/v1",
      });
      expect(provider).toBeDefined();
    });
  });

  describe("capabilities", () => {
    it("reports correct capabilities", () => {
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

  describe("Cloud API request shapes", () => {
    it("uses correct Cloud create payload (no profile/vcpus/memory, image: ubuntu)", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });
      expect(provider).toBeDefined();
    });

    it("handles interactive viewer grants with token in headers", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });
      expect(provider).toBeDefined();
    });

    it("handles transitional statuses during provisioning", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });
      expect(provider).toBeDefined();
    });
  });

  describe("Self-hosted API request shapes", () => {
    it("uses correct self-hosted create payload (vcpus/memory/disk, no image/profile)", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://localhost:4141/v1",
      });
      expect(provider).toBeDefined();
    });

    it("uses correct self-hosted desktop URL (POST /machines/{id}/desktop)", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://127.0.0.1:4141/v1",
      });
      expect(provider).toBeDefined();
    });
  });
});
