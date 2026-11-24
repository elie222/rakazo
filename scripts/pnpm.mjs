import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

function command(args, options) {
  const entry = (options?.env ?? process.env).npm_execpath;
  if (process.platform === "win32" && entry && path.isAbsolute(entry)) {
    const base = path.basename(entry);
    // Corepack and npm installs point at pnpm's Node entry; the standalone pnpm points at its own executable.
    if (/^pnpm\.(?:cjs|mjs|js)$/i.test(base)) return [process.execPath, [entry, ...args]];
    if (/^pnpm\.exe$/i.test(base)) return [entry, args];
  }
  return ["pnpm", args];
}

export function runPnpm(args, options) {
  const [executable, argv] = command(args, options);
  return execFileSync(executable, argv, options);
}

export function spawnPnpm(args, options) {
  const [executable, argv] = command(args, options);
  return spawn(executable, argv, options);
}
