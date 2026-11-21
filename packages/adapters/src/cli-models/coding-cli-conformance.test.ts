import { describe, expect, it } from "vitest";
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
    });
    expect(connection).toMatchObject({
      providerId: "cursor",
      apiKey: "fake-key",
      command: "agent",
    });
  });
});
