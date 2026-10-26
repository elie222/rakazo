import { setTimeout as delay } from "node:timers/promises";
import type { DesktopSandbox } from "novita-sandbox";
import { Novita, SandboxNotFoundError, TimeoutError } from "novita-sandbox";
import { NOVITA_COMPUTER_TEMPLATE } from "./novita-template.js";
import type {
  CommandStartOpts,
  RemoteDesktop,
  RemoteDesktopSdk,
} from "./remote-desktop-sandbox.js";
import { RemoteDesktopSandboxProvider } from "./remote-desktop-sandbox.js";

export interface NovitaSandboxOptions {
  apiKey: string;
  template?: string;
}

/** Novita owns the VM lifecycle; the shared Linux runtime owns each bot's desktop. */
export class NovitaSandboxProvider extends RemoteDesktopSandboxProvider {
  constructor(options: NovitaSandboxOptions, sdk?: RemoteDesktopSdk) {
    super({
      id: "novita",
      label: "Novita",
      apiKey: options.apiKey,
      template: options.template?.trim() || NOVITA_COMPUTER_TEMPLATE,
      sdk: sdk ?? novitaSdk(options.apiKey),
      isTimeoutError: (error) => error instanceof TimeoutError,
    });
  }
}

function novitaSdk(apiKey: string): RemoteDesktopSdk {
  const client = new Novita({ apiKey, requestTimeoutMs: 15_000 });
  const wrap = (desktop: DesktopSandbox) =>
    novitaDesktop(desktop, () => pauseNovitaComputer(client, desktop.sandboxId));
  return {
    create: async (template, options) => wrap(await client.desktop.create(template, options)),
    connect: async (id, options) => wrap(await client.desktop.connect(id, options)),
    pause: (id) => pauseNovitaComputer(client, id),
    kill: (id) => destroyNovitaComputer(client, id),
  };
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
    await pauseNovitaComputer(client, id);
  } catch (pauseError) {
    throw new AggregateError(
      [lastError, pauseError],
      "Novita computer deletion and pause both failed; the computer may still be running",
    );
  }
  throw new Error("Novita computer deletion was not confirmed; the computer was paused instead", {
    cause: lastError,
  });
}

async function runNovitaCommand(
  desktop: Pick<DesktopSandbox, "commands">,
  command: string,
  options: CommandStartOpts,
  pause: () => Promise<void>,
) {
  const { signal, ...opts } = options;
  signal?.throwIfAborted();
  const handle = await desktop.commands.run(command, { ...opts, background: true });
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
    const commandDeadline =
      error instanceof TimeoutError &&
      /^deadline_exceeded|exceeding 'timeoutMs'/.test(error.message);
    if (!signal?.aborted && !commandDeadline) throw error;
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
    try {
      await pause();
    } catch (pauseError) {
      throw new AggregateError(
        [killError, pauseError],
        "Novita command termination and computer pause both failed; the computer may still be running",
      );
    }
    throw new Error(
      "Novita computer was paused after command termination failed; the command may remain suspended",
      { cause: killError },
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    await handle.disconnect();
  }
}
