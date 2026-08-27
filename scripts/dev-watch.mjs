#!/usr/bin/env node
// Run `tsx watch` for a dev service with stdin detached.
//
// tsx watch registers `process.stdin.on("data")` for its press-Return-to-restart shortcut. Under
// turbo on Windows the inherited stdin handle never delivers data and never closes, and the watched
// process then never reaches its entrypoint: no output, no listening port, no error. Outside turbo
// the same command starts in about two seconds.
//
// These services are non-interactive, so nothing is lost by dropping stdin, and doing it here keeps
// the fix in one place rather than in a shell redirect that would have to differ per platform.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const child = spawn(process.execPath, [tsxCli, "watch", ...process.argv.slice(2)], {
  stdio: ["ignore", "inherit", "inherit"],
});

const forward = (signal) => {
  process.on(signal, () => child.kill(signal));
};
forward("SIGINT");
forward("SIGTERM");

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
