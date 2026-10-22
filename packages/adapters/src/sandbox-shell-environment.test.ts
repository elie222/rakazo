import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellExportScript } from "./sandbox-shell-environment.js";

function exported(script: string, name: string) {
  return spawnSync("bash", ["-c", `eval "$(cat)" && printenv ${name}`], {
    input: script,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

describe("shellExportScript", () => {
  it("exports values exactly, whatever they contain", () => {
    const value = `fake'secret "$HOME" $(touch /tmp/never) \`id\`\nline two`;
    const result = exported(shellExportScript({ FAKE_TOKEN: value, OTHER: "" }), "FAKE_TOKEN");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${value}\n`);
  });

  it("is empty without variables", () => {
    expect(shellExportScript({})).toBe("");
  });

  it.each(["1ABC", "A-B", "A B", "A=B", "", "$(id)", "A;B"])(
    "rejects the invalid name %j",
    (name) => {
      expect(() => shellExportScript({ [name]: "fake" })).toThrow(
        "invalid environment variable name",
      );
    },
  );

  it("fails when an assignment cannot be made", () => {
    expect(exported(shellExportScript({ OK: "fake", EUID: "0" }), "OK").status).not.toBe(0);
  });
});
