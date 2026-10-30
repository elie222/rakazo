import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const helper = pathToFileURL(new URL("./shutdown-signals.ts", import.meta.url).pathname).href;

// Registered after ours, like Composio's telemetry or graphile-worker: clean up, then re-raise.
const program = `
import { stopOnShutdownSignals } from ${JSON.stringify(helper)};
let stopping = false;
stopOnShutdownSignals(() => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => {
    console.log("runs handed back");
    process.exit(0);
  }, 200);
});
const reraise = () => {
  process.removeListener("SIGTERM", reraise);
  process.kill(process.pid, "SIGTERM");
};
process.on("SIGTERM", reraise);
setInterval(() => {}, 1_000);
console.log("ready");
`;

describe("shutdown signals", () => {
  it("keeps the process alive until stop finishes when a library re-raises SIGTERM", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "--no-warnings", "-e", program], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    const ready = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("ready")) resolve();
      });
    });
    const exited = once(child, "exit");
    try {
      await ready;
      child.kill("SIGTERM");
      const [code, signal] = await exited;
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(output).toContain("runs handed back");
    } finally {
      child.kill("SIGKILL");
    }
  });
});
