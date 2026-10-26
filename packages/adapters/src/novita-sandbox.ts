import { setTimeout as delay } from "node:timers/promises";
import type { CommandHandle, DesktopSandbox } from "novita-sandbox";
import {
  CommandExitError,
  DesktopSandbox as NativeDesktop,
  Novita,
  SandboxNotFoundError,
  TimeoutError,
} from "novita-sandbox";
import { sandboxIdleMs } from "./computer-idle.js";
import { NOVITA_COMPUTER_TEMPLATE } from "./novita-template.js";
import type {
  CommandStartOpts,
  RemoteDesktop,
  RemoteDesktopSdk,
} from "./remote-desktop-sandbox.js";
import { RemoteDesktopSandboxProvider } from "./remote-desktop-sandbox.js";
import { isSandboxGoneError, SandboxUnsafeStopError } from "./sandbox-errors.js";

export interface NovitaSandboxOptions {
  apiKey: string;
  template?: string;
  onUnsafeStop?: (providerRef: string) => Promise<void>;
}

/** Novita owns the VM lifecycle; the shared Linux runtime owns each bot's desktop. */
export class NovitaSandboxProvider extends RemoteDesktopSandboxProvider {
  constructor(options: NovitaSandboxOptions, sdk?: RemoteDesktopSdk) {
    super({
      id: "novita",
      label: "Novita",
      apiKey: options.apiKey,
      template: options.template?.trim() || NOVITA_COMPUTER_TEMPLATE,
      sdk: sdk ?? novitaSdk(options.apiKey, options.onUnsafeStop),
      isTimeoutError: (error) => error instanceof TimeoutError,
    });
  }
}

export function novitaSdk(
  apiKey: string,
  onUnsafeStop?: (providerRef: string) => Promise<void>,
): RemoteDesktopSdk {
  const client = new Novita({ apiKey, requestTimeoutMs: 15_000 });
  const safetyPause = async (id: string) => {
    // Fence other API/worker instances before suspending a process whose stop is uncertain.
    try {
      await onUnsafeStop?.(id);
    } finally {
      await pauseNovitaComputer(client, id);
    }
  };
  const wrap = (desktop: DesktopSandbox) =>
    novitaDesktop(desktop, () => safetyPause(desktop.sandboxId));
  return {
    create: async (template, options) => wrap(await client.desktop.create(template, options)),
    connect: async (id, options) => wrap(await client.desktop.connect(id, options)),
    connectRunning: async (id) => wrap(await runningNovitaDesktop(apiKey, id)),
    keepAlive: (id, options) => client.sandbox.setTimeout(id, options.timeoutMs),
    pause: (id) => pauseNovitaComputer(client, id),
    kill: (id) => destroyNovitaComputer(client, id, safetyPause),
  };
}

/** A GET and local handle construction must never resume a paused guest. */
export async function runningNovitaDesktop(apiKey: string, id: string): Promise<DesktopSandbox> {
  const info = await NativeDesktop.getFullInfo(id, { apiKey, requestTimeoutMs: 15_000 });
  if (info.state !== "running")
    throw new Error("Novita computer is paused; start it before using it");
  if (info.sandboxId !== id || typeof info.envdVersion !== "string")
    throw new Error("Invalid Novita computer identity");
  const options = {
    apiKey,
    requestTimeoutMs: 15_000,
    sandboxId: info.sandboxId,
    sandboxDomain: info.sandboxDomain,
    envdVersion: info.envdVersion,
    envdAccessToken: info.envdAccessToken,
    trafficAccessToken: info.trafficAccessToken,
  };
  try {
    await NativeDesktop.setTimeout(id, sandboxIdleMs(), { apiKey, requestTimeoutMs: 15_000 });
  } catch (error) {
    const current = await NativeDesktop.getFullInfo(id, { apiKey, requestTimeoutMs: 15_000 });
    if (current.state !== "running")
      throw new Error("Novita computer is paused; start it before using it");
    if (isSandboxGoneError(error))
      throw new Error("Novita computer is present but its idle timeout could not be extended");
    throw error;
  }
  return new NativeDesktop(options);
}

/** Novita has no per-call AbortSignal; translate cancellation at the SDK boundary. */
export function novitaDesktop(desktop: DesktopSandbox, pause: () => Promise<void>): RemoteDesktop {
  return {
    sandboxId: desktop.sandboxId,
    getHost: (port) => desktop.getHost(port),
    setTimeout: (timeoutMs) => desktop.setTimeout(timeoutMs),
    commands: { run: (command, options) => runNovitaCommand(desktop, command, options, pause) },
    files: {
      makeDir: (path) => desktop.files.makeDir(path),
      list: (path, options) => fileRequest(options.signal, () => desktop.files.list(path)),
      getInfo: (path, options) => fileRequest(options.signal, () => desktop.files.getInfo(path)),
      read: (path, options) =>
        fileRequest(options.signal, () => desktop.files.read(path, { format: "bytes" })),
      write: (files, options) => fileRequest(options.signal, () => desktop.files.write(files)),
    },
  };
}

async function fileRequest<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const result = await work();
  signal?.throwIfAborted();
  return result;
}

/** Pause is idempotent; a lost acknowledgement must not leave compute billing unchecked. */
export async function pauseNovitaComputer(
  client: Pick<Novita, "sandbox">,
  id: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await client.sandbox.pause(id, { sync: true });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return;
      lastError = error;
    }
    try {
      const info = await client.sandbox.getInfo(id);
      if (info.state === "paused") return;
      lastError ??= new Error("Novita computer is still running after pause");
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return;
      lastError = error;
    }
    if (attempt < 2) await delay(1000 * 2 ** attempt);
  }
  throw new Error(
    "Novita computer could not be paused after three attempts; it may still be running",
    { cause: lastError },
  );
}

/** Deletion retries never resume a paused computer, even after a lost acknowledgement. */
export async function destroyNovitaComputer(
  client: Pick<Novita, "sandbox">,
  id: string,
  safetyPause: (id: string) => Promise<void> = (id) => pauseNovitaComputer(client, id),
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!(await client.sandbox.kill(id))) return false;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return false;
      lastError = error;
    }
    try {
      await client.sandbox.getInfo(id);
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return true;
      lastError = error;
    }
    if (attempt < 2) await delay(1000 * 2 ** attempt);
  }
  try {
    await safetyPause(id);
  } catch (pauseError) {
    throw new SandboxUnsafeStopError(
      "Novita computer deletion and pause both failed; the computer may still be running",
      new AggregateError([lastError, pauseError]),
    );
  }
  throw new SandboxUnsafeStopError(
    "Novita computer deletion was not confirmed; the computer was paused instead",
    lastError,
  );
}

async function runNovitaCommand(
  desktop: Pick<DesktopSandbox, "commands">,
  command: string,
  options: CommandStartOpts,
  pause: () => Promise<void>,
) {
  const { signal, ...opts } = options;
  signal?.throwIfAborted();
  let handle: CommandHandle;
  try {
    handle = await desktop.commands.run(command, { ...opts, background: true });
  } catch (error) {
    // The process can start before its start event reaches us, leaving no PID to kill.
    if (error instanceof CommandExitError) throw error;
    return pauseAfterUnsafeCommand(pause, error);
  }
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal?.reason ?? new Error("command aborted"));
  });
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const result = await Promise.race([handle.wait(), aborted]);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    // A non-zero command exit is complete. A broken stream or deadline says nothing
    // about the remote process, so terminate it before reporting that failure.
    if (!signal?.aborted && error instanceof CommandExitError) throw error;
    let killError: unknown;
    let killed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await handle.kill();
        killed = true;
        break;
      } catch (failure) {
        killError = failure;
      }
      if (attempt < 2) await delay(250 * 2 ** attempt);
    }
    if (killed) {
      if (signal?.aborted)
        return { exitCode: 130, stdout: handle.stdout, stderr: "command aborted\n" };
      throw error;
    }
    return pauseAfterUnsafeCommand(pause, killError);
  } finally {
    signal?.removeEventListener("abort", abort);
    await handle.disconnect();
  }
}

async function pauseAfterUnsafeCommand(pause: () => Promise<void>, cause: unknown): Promise<never> {
  try {
    await pause();
  } catch (pauseError) {
    throw new SandboxUnsafeStopError(
      "Novita command termination failed and the safety stop could not be completed; the computer may still be running",
      new AggregateError([cause, pauseError]),
    );
  }
  throw new SandboxUnsafeStopError(
    "Novita computer was paused after command termination failed; the command may remain suspended",
    cause,
  );
}
