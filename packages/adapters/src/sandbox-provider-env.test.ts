import { describe, expect, it } from "vitest";
import { resolveSandboxProvider } from "./sandbox-provider-env.js";

describe("resolveSandboxProvider", () => {
  it("defaults to docker", () => {
    expect(resolveSandboxProvider({})).toBe("docker");
  });

  it("keeps explicit none", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "none" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "" })).toBe("none");
  });

  it("falls back to none when a remote provider key is missing", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "e2b" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "daytona" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "box" })).toBe("none");
  });

  it("falls back to none in production when Docker has no supervisor token", () => {
    expect(
      resolveSandboxProvider({
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "docker",
      }),
    ).toBe("none");
  });

  it("keeps docker in production when a supervisor token is set", () => {
    expect(
      resolveSandboxProvider({
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "docker",
        SANDBOX_SUPERVISOR_TOKEN: "prod-supervisor-token-with-enough-length",
      }),
    ).toBe("docker");
  });
});
