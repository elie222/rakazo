import { describe, expect, it, vi } from "vitest";

// Fail on module evaluation, rather than merely checking which provider was returned.
vi.mock("./wuying-sandbox.js", () => {
  throw new Error("Wuying loaded on default path");
});
vi.mock("@alicloud/ecd20200930", () => {
  throw new Error("ECD loaded on default path");
});
vi.mock("@alicloud/appstream-center20210218", () => {
  throw new Error("Appstream loaded on default path");
});
vi.mock("@alicloud/openapi-core", () => {
  throw new Error("OpenAPI loaded on default path");
});
vi.mock("@darabonba/typescript", () => {
  throw new Error("Darabonba loaded on default path");
});

import { createRunSandbox } from "./index.js";
import { createSandboxProvider } from "./sandbox-factory.js";

describe("optional Wuying loading", () => {
  it("does not evaluate Wuying or Alibaba modules through the default factory or barrel", async () => {
    expect(
      (
        await createSandboxProvider("docker", {
          wuyingAccessKeyId: "fake-key",
          wuyingAccessKeySecret: "fake-secret",
          wuyingDesktopId: "ecd-fake",
          wuyingEndUserId: "fake-user",
          wuyingMcpUrl: "https://gateway.example.test/mcp",
          wuyingMcpToken: "fake-token",
        })
      ).describe().id,
    ).toBe("docker");
    expect((await createRunSandbox("none", {})).describe().id).toBe("none");
    expect((await createSandboxProvider("wuying", {})).describe().id).toBe("none");
  });
});
