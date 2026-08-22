import { homedir } from "node:os";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { createSandboxProvider, type SandboxProviderOptions } from "./sandbox-factory.js";

/**
 * Bots always run on the provider the operator configured at deploy time. `desktop`
 * executes commands on the host under the server's own OS account, so it is only
 * reachable by setting SANDBOX_PROVIDER=desktop — never from a connected client.
 */
export function createRunSandbox(kind: string, opts: SandboxProviderOptions): SandboxProvider {
  if (kind === "desktop") {
    return new DesktopSandboxProvider({ root: opts.dataDir, hostRoots: [homedir()] });
  }
  return createSandboxProvider(kind, opts);
}
