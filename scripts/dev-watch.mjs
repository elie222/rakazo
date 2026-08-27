#!/usr/bin/env node
// Spawn `tsx watch` with stdin ignored. Under turbo on Windows an inherited stdin
// handle that never closes prevents tsx watch from reaching the entrypoint.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const child = spawn(process.execPath, [tsxCli, "watch", ...process.argv.slice(2)], {
  stdio: ["ignore", "inherit", "inherit"],
});

const onSigint = () => child.kill("SIGINT");
const onSigterm = () => child.kill("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

child.on("exit", (code, signal) => {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
