import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import type { NativeProcessTree } from "../providers/computer/desktop/desktop-process-tree.js";
import { windowsProcessTree } from "../providers/computer/desktop/desktop-process-tree.js";

// Nothing launches until the parent owns the wrapper's Job. Only the first line is bootstrap;
// subsequent stdin belongs to the CLI protocol, including bytes in the same chunk.
export const WINDOWS_HOST_WRAPPER = `
const { spawn } = require('node:child_process');
let input = '';
let started = false;
function receive(chunk) {
  input += chunk;
  const newline = input.indexOf('\\n');
  if (newline === -1) return;
  process.stdin.removeListener('data', receive);
  process.stdin.pause();
  const { argv, env } = JSON.parse(input.slice(0, newline));
  const remaining = input.slice(newline + 1);
  input = '';
  started = true;
  const child = spawn(argv[0], argv.slice(1), { env, shell: false, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  child.stdin.on('error', () => {});
  if (remaining) child.stdin.write(remaining);
  process.stdin.pipe(child.stdin);
  child.on('error', (error) => { process.stdin.destroy(); console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.stdin.destroy(); process.exitCode = code ?? 1; });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', receive);
process.stdin.on('end', () => { if (!started) process.exitCode = 1; });
`;

export function spawnWindowsHostCommand(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { child: ChildProcessWithoutNullStreams; tree: NativeProcessTree } {
  const child = spawn(process.execPath, ["-e", WINDOWS_HOST_WRAPPER], {
    cwd,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    shell: false,
    windowsHide: true,
  });
  let tree: NativeProcessTree;
  try {
    tree = child.pid
      ? windowsProcessTree(child.pid)
      : { alive: () => false, kill() {}, close() {} };
  } catch (error) {
    child.on("error", () => undefined);
    child.kill("SIGKILL");
    throw error;
  }
  child.stdin.on("error", () => undefined);
  child.stdin.write(`${JSON.stringify({ argv, env })}\n`);
  return { child, tree };
}
