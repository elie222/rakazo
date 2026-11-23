import type { CreateSandboxFromSnapshotParams, FileInfo, SandboxState } from "@daytona/sdk";
import {
  DaytonaConflictError,
  DaytonaNotFoundError,
  DaytonaTimeoutError,
  DaytonaValidationError,
} from "@daytona/sdk";
import { parse } from "shell-quote";
import { vi } from "vitest";
import {
  desktopCommandResponder,
  simpleCommand,
} from "../../../computers/screens/linux-desktop.test-support.js";
import type { DaytonaSandbox, DaytonaSandboxSdk } from "./daytona-sandbox.js";
import { DaytonaSandboxProvider } from "./daytona-sandbox.js";

export function daytonaFixture(
  options: {
    id?: string;
    createdId?: string;
    state?: SandboxState;
    desiredState?: DaytonaSandbox["desiredState"];
    recoverable?: boolean;
    later?: SandboxState[];
    prepareFails?: boolean;
  } = {},
) {
  const remote: {
    id: string;
    name?: string;
    missing: boolean;
    state: SandboxState;
    desiredState?: DaytonaSandbox["desiredState"];
    recoverable?: boolean;
  } = {
    id: options.id ?? "daytona-box",
    missing: options.state === undefined,
    state: options.state ?? "started",
    desiredState: options.desiredState ?? "started",
    recoverable: options.recoverable,
  };
  const transitions = [...(options.later ?? [])];
  const notFound = () =>
    new DaytonaNotFoundError(`Sandbox with ID or name ${remote.id} not found`, 404);
  const sync = () => {
    if (remote.missing) throw notFound();
    sandbox.id = remote.id;
    sandbox.state = remote.state;
    sandbox.desiredState = remote.desiredState;
    sandbox.recoverable = remote.recoverable;
  };
  const settle = (state: SandboxState) => {
    remote.state = state;
    remote.desiredState = state === "started" || state === "stopped" ? state : remote.desiredState;
    sync();
  };

  const files = new Map<string, Buffer>();
  const modes = new Map<string, string>();
  const screenRegistry = desktopCommandResponder();
  const executeCommand = vi.fn(
    async (command: string, _cwd?: string, env?: Record<string, string>, _timeout?: number) => {
      const registryResult = screenRegistry(command);
      if (registryResult)
        return { exitCode: registryResult.exitCode, result: registryResult.stdout };
      if (options.prepareFails && command.startsWith("mkdir -p -- ")) {
        return { exitCode: 1, result: "could not create Daytona workspace" };
      }
      if (command.startsWith("chmod 700 -- ")) {
        for (const match of command.matchAll(/'([^']+)'/g)) modes.set(match[1]!, "0755");
      }
      const parsed = parse(command);
      const argv = parsed.filter((token): token is string => typeof token === "string");
      if (argv.length !== parsed.length) return { exitCode: 0, result: "" };
      const { exitCode = 0, stdout = "" } = simpleCommand(argv, env ?? {});
      return { exitCode, result: stdout };
    },
  );
  const uploadFile = vi.fn(async (content: Buffer, target: string) => {
    files.set(target, Buffer.from(content));
    modes.set(target, modes.get(target) ?? "0644");
  });
  const downloadFile = vi.fn(async (target: string) => Buffer.from(files.get(target) ?? []));
  const listFiles = vi.fn(async (directory: string) => {
    const prefix = `${directory.replace(/\/$/, "")}/`;
    const entries = new Map<string, FileInfo>();
    for (const [target, content] of files) {
      if (!target.startsWith(prefix)) continue;
      const remainder = target.slice(prefix.length);
      const [name, ...rest] = remainder.split("/");
      if (!name) continue;
      entries.set(
        name,
        fileInfo(name, rest.length > 0, rest.length ? 0 : content.byteLength, modes.get(target)),
      );
    }
    return [...entries.values()];
  });

  const refreshData = vi.fn(async () => {
    const next = transitions.shift();
    if (next) settle(next);
    sync();
  });
  const start = vi.fn(async (_timeout?: number) => {
    if (remote.missing) throw notFound();
    if (remote.state === "error" || remote.state === "build_failed") {
      throw new DaytonaValidationError("Sandbox is in an errored state", 400);
    }
    if (!["stopped", "paused", "archived"].includes(remote.state)) {
      throw new DaytonaConflictError("Sandbox state change in progress", 409);
    }
    settle("started");
  });
  const recover = vi.fn(async (_timeout?: number) => {
    if (!remote.recoverable) throw new DaytonaValidationError("Sandbox is not recoverable", 400);
    remote.recoverable = undefined;
    settle("started");
  });
  const waitUntilStarted = vi.fn(async (_timeout?: number) => {
    if (remote.desiredState !== "started") {
      throw new DaytonaTimeoutError("Sandbox failed to become ready within the timeout period");
    }
    settle("started");
  });
  const stop = vi.fn(async (_timeout?: number, _force?: boolean) => {
    if (remote.missing) throw notFound();
    if (!["started", "paused"].includes(remote.state)) {
      throw ["stopped", "archived", "error", "build_failed"].includes(remote.state)
        ? new DaytonaValidationError(`Sandbox is ${remote.state}`, 400)
        : new DaytonaConflictError("Sandbox state change in progress", 409);
    }
    settle("stopped");
  });
  const deleteSandbox = vi.fn(async (_timeout?: number, _wait?: boolean) => {
    if (remote.missing) throw notFound();
    remote.missing = true;
  });
  const expireSignedPreviewUrl = vi.fn(async (_port: number, _token: string) => undefined);
  const getSignedPreviewUrl = vi.fn(async (port: number, _expiresInSeconds?: number) => ({
    sandboxId: remote.id,
    port,
    url: `https://${port}-preview.proxy.daytona.test`,
    token: "preview-token",
  }));

  const sandbox: DaytonaSandbox & {
    fs: { uploadFile: typeof uploadFile; listFiles: typeof listFiles };
  } = {
    id: remote.id,
    state: remote.state,
    desiredState: remote.desiredState,
    recoverable: remote.recoverable,
    process: { executeCommand },
    fs: {
      uploadFile,
      downloadFile,
      listFiles,
      getFileDetails: vi.fn(async (target: string) =>
        fileInfo(target.split("/").at(-1) ?? target, false, files.get(target)?.byteLength ?? 0),
      ),
    },
    computerUse: { stop: vi.fn(async () => ({ message: "stopped" })) },
    getUserHomeDir: vi.fn(async () => "/home/daytona"),
    getWorkDir: vi.fn(async () => "/home/daytona"),
    getSignedPreviewUrl,
    expireSignedPreviewUrl,
    refreshActivity: vi.fn(async () => undefined),
    refreshData,
    start,
    recover,
    waitUntilStarted,
    stop,
    delete: deleteSandbox,
  };

  const create = vi.fn(
    async (params: CreateSandboxFromSnapshotParams, _options: { timeout: number }) => {
      Object.assign(remote, {
        id: options.createdId ?? options.id ?? "daytona-box",
        name: params.name,
        missing: false,
        recoverable: undefined,
      });
      settle("started");
      return sandbox;
    },
  );
  const get = vi.fn(async (idOrName: string) => {
    if (idOrName !== remote.id && idOrName !== remote.name) throw notFound();
    sync();
    return sandbox;
  });
  const client = { create, get } satisfies DaytonaSandboxSdk;

  return {
    options,
    remote,
    sandbox,
    client,
    create,
    get,
    executeCommand,
    refreshData,
    start,
    recover,
    waitUntilStarted,
    stop,
    deleteSandbox,
    getSignedPreviewUrl,
    expireSignedPreviewUrl,
  };
}

export function fileInfo(name: string, isDir: boolean, size: number, mode = "0644"): FileInfo {
  return {
    group: "daytona",
    isDir,
    modTime: "",
    modifiedAt: "2026-01-01T00:00:00Z",
    mode,
    name,
    owner: "daytona",
    permissions: mode === "0755" ? "rwxr-xr-x" : "rw-r--r--",
    size,
  };
}

/** The real Daytona adapter over one in-memory sandbox. */
export function emulatedDaytona() {
  const fixture = daytonaFixture();
  return { fixture, provider: new DaytonaSandboxProvider({}, fixture.client) };
}
