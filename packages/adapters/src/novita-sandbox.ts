import type { DesktopSandbox } from "novita-sandbox";
import { Novita, TimeoutError } from "novita-sandbox";
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
    const client = sdk
      ? undefined
      : new Novita({ apiKey: options.apiKey, requestTimeoutMs: 15_000 });
    super({
      id: "novita",
      label: "Novita",
      apiKey: options.apiKey,
      template: options.template?.trim() || NOVITA_COMPUTER_TEMPLATE,
      sdk: sdk ?? {
        create: async (template, opts) =>
          novitaDesktop(await client!.desktop.create(template, opts)),
        connect: async (id, opts) => novitaDesktop(await client!.desktop.connect(id, opts)),
        pause: (id, opts) => client!.sandbox.pause(id, opts),
        kill: (id, opts) => client!.sandbox.kill(id, opts),
      },
      isTimeoutError: (error) => error instanceof TimeoutError,
    });
  }
}

/** Novita has no per-call AbortSignal; translate cancellation at the SDK boundary. */
export function novitaDesktop(desktop: DesktopSandbox): RemoteDesktop {
  return {
    sandboxId: desktop.sandboxId,
    getHost: (port) => desktop.getHost(port),
    setTimeout: (timeoutMs) => desktop.setTimeout(timeoutMs),
    commands: { run: (command, options) => runNovitaCommand(desktop, command, options) },
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

async function runNovitaCommand(
  desktop: Pick<DesktopSandbox, "commands">,
  command: string,
  options: CommandStartOpts,
) {
  const { signal, ...opts } = options;
  signal?.throwIfAborted();
  const handle = await desktop.commands.run(command, { ...opts, background: true });
  let killing: Promise<unknown> | undefined;
  const abort = () => {
    killing ??= handle.kill();
    void killing.catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const result = await handle.wait();
    return signal?.aborted
      ? { exitCode: 130, stdout: handle.stdout, stderr: "command aborted\n" }
      : result;
  } catch (error) {
    if (!signal?.aborted) throw error;
    return { exitCode: 130, stdout: handle.stdout, stderr: "command aborted\n" };
  } finally {
    signal?.removeEventListener("abort", abort);
    await killing;
  }
}
