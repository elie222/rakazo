import type { Sandbox as RailwaySandbox } from "railway";
import { Sandbox, SandboxNotFoundError } from "railway";
import { parse } from "shell-quote";
import { vi } from "vitest";
import { simpleCommand } from "../../../linux-desktop.test-support.js";
import { RailwaySandboxProvider } from "./railway-sandbox.js";

/**
 * The real Railway adapter over in-memory sandboxes in place of the SDK's: they run until
 * destroyed, and their shell understands `env`, `echo` and `printenv`.
 */
export function emulatedRailway() {
  const sandboxes = new Map<string, RailwaySandbox>();
  let sequence = 0;
  const create = () => {
    const id = `sandbox-${++sequence}`;
    const sandbox = {
      id,
      status: "RUNNING",
      networkIsolation: "PRIVATE",
      environmentId: "environment",
      createdAt: new Date().toISOString(),
      domains: [{ port: 6080, domain: `${id}.up.railway.test` }],
      heartbeat: async () => sandbox,
      destroy: async () => {
        sandbox.status = "DESTROYED";
        sandboxes.delete(id);
      },
      exec: async (command: string, options?: { env?: Record<string, string> }) => {
        const parsed = parse(command);
        const argv = parsed.filter((token): token is string => typeof token === "string");
        const { exitCode = 0, stdout = "" } =
          argv.length === parsed.length ? simpleCommand(argv, options?.env ?? {}) : {};
        return { exitCode, stdout, stderr: "", truncated: false, timedOut: false };
      },
    };
    const handle = sandbox as unknown as RailwaySandbox;
    sandboxes.set(id, handle);
    return handle;
  };
  vi.spyOn(Sandbox, "create").mockImplementation(async () => create());
  vi.spyOn(Sandbox, "connect").mockImplementation(async (id) => {
    const sandbox = sandboxes.get(id);
    if (!sandbox) throw new SandboxNotFoundError({ id, environmentId: "environment" });
    return sandbox;
  });
  return {
    sandboxes,
    provider: new RailwaySandboxProvider({
      token: "test-railway-token",
      environmentId: "environment",
    }),
  };
}
