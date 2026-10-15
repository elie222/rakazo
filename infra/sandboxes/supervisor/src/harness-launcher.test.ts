import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const launcher = fileURLToPath(new URL("../../harness/launch.py", import.meta.url));
function run(frame: unknown, remaining = "") {
  return spawnSync("python3", ["-I", launcher], {
    input: `${JSON.stringify(frame)}\n${remaining}`,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOST_ONLY_SECRET: "host-value",
      NODE_OPTIONS: "hostile-value",
    },
  });
}

describe("private runtime credential bootstrap", () => {
  it("preserves native stdin and uses an exact private environment", () => {
    const result = run(
      {
        argv: [
          "/usr/bin/python3",
          "-I",
          "-c",
          "import os,sys,json;print(json.dumps(dict(os.environ)));print(sys.stdin.read())",
        ],
        env: { OPENAI_API_KEY: "fake-api-value" },
      },
      "native request\n",
    );
    expect(result.status).toBe(0);
    const lines = result.stdout.split("\n");
    const env = JSON.parse(lines[0] ?? "{}");
    expect(env).toMatchObject({
      OPENAI_API_KEY: "fake-api-value",
      HOME: "/home/harness",
      CODEX_HOME: "/home/harness/.codex",
    });
    expect(env.HOST_ONLY_SECRET).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(lines[1]).toBe("native request");
  });

  it("passes only the documented bearer and model role variables to the child", () => {
    const roles = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "provider/fast[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "provider/balanced",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "provider/reasoning",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "provider/fable",
      CLAUDE_CODE_SUBAGENT_MODEL: "provider/helper",
    };
    const result = run({
      argv: ["/usr/bin/python3", "-I", "-c", "import os,json;print(json.dumps(dict(os.environ)))"],
      env: { ANTHROPIC_AUTH_TOKEN: "fake-bearer", ...roles },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "fake-bearer",
      ...roles,
    });
    expect(JSON.parse(result.stdout).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it.each([
    { ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_AUTH_TOKEN: "fake-token" },
    { ANTHROPIC_DEFAULT_HAIKU_MODEL: " " },
    { ANTHROPIC_DEFAULT_SONNET_MODEL: "model\nvalue" },
    { ANTHROPIC_DEFAULT_OPUS_MODEL: "a".repeat(201) },
    { ANTHROPIC_DEFAULT_FABLE_MODEL: "\u007f" },
    { CLAUDE_CODE_SUBAGENT_MODEL: "😀".repeat(101) },
    { ANTHROPIC_DEFAULT_UNKNOWN_MODEL: "unknown" },
  ])(
    "rejects ambiguous authentication or invalid model role values without disclosing them",
    (env) => {
      const result = run({ argv: ["/usr/bin/true"], env });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("Isolated runtime bootstrap failed.\n");
      expect(result.stdout).toBe("");
    },
  );

  it.each(["LD_PRELOAD", "PYTHONPATH", "NODE_OPTIONS", "HOME", "PATH"])(
    "rejects %s without rendering secret input",
    (key) => {
      const result = run({ argv: ["/usr/bin/true"], env: { [key]: "fake-api-value" } });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("Isolated runtime bootstrap failed.\n");
      expect(result.stdout).toBe("");
    },
  );
});
