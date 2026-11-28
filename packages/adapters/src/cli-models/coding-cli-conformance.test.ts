import { describe, expect, it } from "vitest";
import { codingCliConfigured } from "../runs/tools/run-tools-coding-cli.js";
import { createCodingCliConnection } from "./coding-cli-factory.js";
import { resolveCodingCliProvider } from "./coding-cli-provider-env.js";

describe("coding CLI provider env", () => {
  it.each([
    { CODING_CLI_PROVIDER: "" },
    { CODING_CLI_PROVIDER: "bogus" },
    { CODING_CLI_PROVIDER: "cursor" },
    { CODING_CLI_PROVIDER: "cursor", CURSOR_API_KEY: "fake-key" },
  ] as const)("resolves %# without throwing", (source) => {
    expect(resolveCodingCliProvider(source)).toMatch(/^(none|cursor)$/);
  });

  it("creates a connection only for cursor with a key", () => {
    expect(createCodingCliConnection({ CODING_CLI_PROVIDER: "cursor" })).toBeNull();
    const connection = createCodingCliConnection({
      CODING_CLI_PROVIDER: "cursor",
      CURSOR_API_KEY: "fake-key",
      CLOUD_AGENT_SPACE_ID: "space-a",
    });
    expect(connection).toMatchObject({
      providerId: "cursor",
      apiKey: "fake-key",
      command: "agent",
      spaceId: "space-a",
    });
  });

  it("stays off without a Space to bind the key to", () => {
    expect(
      createCodingCliConnection({ CODING_CLI_PROVIDER: "cursor", CURSOR_API_KEY: "fake-key" }),
    ).toBeNull();
    expect(
      createCodingCliConnection({
        CODING_CLI_PROVIDER: "cursor",
        CURSOR_API_KEY: "fake-key",
        CLOUD_AGENT_SPACE_ID: "  ",
      }),
    ).toBeNull();
  });

  it("offers the coding CLI only in the bound Space", () => {
    const connection = createCodingCliConnection({
      CODING_CLI_PROVIDER: "cursor",
      CURSOR_API_KEY: "fake-key",
      CLOUD_AGENT_SPACE_ID: "space-a",
    });
    expect(codingCliConfigured(connection, "space-a")).toBe(true);
    expect(codingCliConfigured(connection, "space-b")).toBe(false);
    expect(codingCliConfigured(null, "space-a")).toBe(false);
  });
});
