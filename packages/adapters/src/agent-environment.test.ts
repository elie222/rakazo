import { describe, expect, it, vi } from "vitest";
import {
  decryptAgentEnvironment,
  formatAgentEnvironmentInstruction,
  redactAgentCommandResult,
} from "./agent-environment.js";

describe("managed agent environment", () => {
  it("decrypts records into an environment without exposing values in instructions", () => {
    const load = vi.fn((ciphertext: string, id: string) => `${ciphertext}:${id}:private`);
    const environment = decryptAgentEnvironment(
      [
        { name: "AUDIENTI_API_KEY", secret: { id: "secret-1", ciphertext: "cipher-1" } },
        { name: "ARTHUR_TOKEN", secret: { id: "secret-2", ciphertext: "cipher-2" } },
      ],
      { load },
    );

    expect(environment).toEqual({
      AUDIENTI_API_KEY: "cipher-1:secret-1:private",
      ARTHUR_TOKEN: "cipher-2:secret-2:private",
    });
    const instruction = formatAgentEnvironmentInstruction(environment);
    expect(instruction).toContain("AUDIENTI_API_KEY");
    expect(instruction).toContain("ARTHUR_TOKEN");
    expect(instruction).not.toContain("private");
  });

  it("redacts managed values before shell results return to the model", () => {
    expect(
      redactAgentCommandResult(
        { stdout: "token=private-value\n", stderr: "private-value", code: 0 },
        ["private-value"],
      ),
    ).toEqual({ stdout: "token=[redacted]\n", stderr: "[redacted]", code: 0 });
  });
});
