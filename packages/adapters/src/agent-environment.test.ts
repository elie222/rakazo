import { describe, expect, it } from "vitest";
import {
  decryptAgentEnvironment,
  formatAgentEnvironmentInstruction,
  redactAgentCommandResult,
} from "./agent-environment.js";

describe("agent-environment", () => {
  it("decrypts named agent secrets", async () => {
    const env = await decryptAgentEnvironment(
      [
        { name: "API_TOKEN", secret: { id: "sec-1", ciphertext: "cipher-1" } },
        { name: "DB_URL", secret: { id: "sec-2", ciphertext: "cipher-2" } },
      ],
      {
        load: async (ciphertext, recordId) => `${recordId}:${ciphertext}`,
      },
    );
    expect(env).toEqual({
      API_TOKEN: "sec-1:cipher-1",
      DB_URL: "sec-2:cipher-2",
    });
  });

  it("rejects invalid secret names", async () => {
    await expect(
      decryptAgentEnvironment([{ name: "lowercase", secret: { id: "sec", ciphertext: "x" } }], {
        load: async () => "x",
      }),
    ).rejects.toThrow();
  });

  it("formats an instruction only when secrets exist", () => {
    expect(formatAgentEnvironmentInstruction({})).toBeUndefined();
    expect(formatAgentEnvironmentInstruction({ Z: "1", A: "2" })).toContain("A, Z");
  });

  it("redacts secret values from command output", () => {
    expect(
      redactAgentCommandResult(
        { stdout: "token=super-secret", stderr: "super-secret failed", code: 1 },
        ["super-secret"],
      ),
    ).toEqual({
      stdout: expect.not.stringContaining("super-secret"),
      stderr: expect.not.stringContaining("super-secret"),
      code: 1,
    });
  });
});
