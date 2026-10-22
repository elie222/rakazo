import { shellQuote } from "./computer-support.js";

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A shell script that exports `env`, for providers whose exec API has no env field. It travels
 * outside the command text, so values never reach the sandbox's process list or command logs.
 */
export function shellExportScript(env: Record<string, string>): string {
  const assignments = Object.entries(env).map(([name, value]) => {
    if (!SHELL_NAME.test(name)) throw new Error(`invalid environment variable name: ${name}`);
    return `${name}=${shellQuote(value)}`;
  });
  // One `export` so the script fails when any assignment does, such as a readonly name.
  return assignments.length ? `export ${assignments.join(" ")}\n` : "";
}
