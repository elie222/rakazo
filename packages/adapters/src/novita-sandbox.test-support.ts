import { FileNotFoundError, SandboxNotFoundError, TimeoutError } from "novita-sandbox";
import { vi } from "vitest";
import { desktopCommandResponder } from "./linux-desktop.test-support.js";
import { NovitaSandboxProvider } from "./novita-sandbox.js";
import type { RemoteDesktop, RemoteDesktopSdk } from "./remote-desktop-sandbox.js";

export function fakeNovita() {
  const machines = new Map<string, { desktop: RemoteDesktop; paused: boolean }>();
  let sequence = 0;
  const sdk: RemoteDesktopSdk = {
    create: vi.fn(async () => {
      const id = `novita-${++sequence}`;
      const files = new Map<string, { content: Uint8Array; mode: number }>();
      const respond = desktopCommandResponder();
      const running = () => {
        if (!machines.has(id)) throw new SandboxNotFoundError(`Sandbox ${id} not found`);
        if (machines.get(id)!.paused)
          throw new TimeoutError("502: This error is likely due to sandbox timeout.");
      };
      const fileAt = (path: string) => {
        running();
        const file = files.get(path);
        if (!file) throw new FileNotFoundError(`Path ${path} not found`);
        return file;
      };
      const desktop: RemoteDesktop = {
        sandboxId: id,
        getHost: (port) => `${port}-${id}.sandbox.test`,
        setTimeout: vi.fn(async () => running()),
        commands: {
          run: vi.fn(async (command) => {
            running();
            if (command.startsWith("chmod 700 --")) {
              for (const [path, file] of files)
                if (command.includes(`'${path}'`)) file.mode = 0o700;
            }
            return (
              respond(command) ?? {
                exitCode: 0,
                stdout: command.includes("'echo' 'graphical-ok'") ? "graphical-ok\n" : "",
                stderr: "",
              }
            );
          }),
        },
        files: {
          makeDir: vi.fn(async () => {
            running();
            return true;
          }),
          list: vi.fn(async (path) => {
            running();
            const entries = new Map<
              string,
              { name: string; type: string; size: number; mode: number }
            >();
            for (const [filePath, file] of files) {
              if (!filePath.startsWith(`${path}/`)) continue;
              const relative = filePath.slice(path.length + 1);
              const name = relative.split("/")[0]!;
              const dir = relative.includes("/");
              entries.set(name, {
                name,
                type: dir ? "dir" : "file",
                size: dir ? 0 : file.content.byteLength,
                mode: file.mode,
              });
            }
            return [...entries.values()];
          }),
          getInfo: vi.fn(async (path) => {
            const file = fileAt(path);
            return {
              name: path.split("/").at(-1)!,
              type: "file",
              size: file.content.byteLength,
              mode: file.mode,
            };
          }),
          read: vi.fn(async (path) => fileAt(path).content),
          write: vi.fn(async (batch) => {
            running();
            for (const file of batch)
              files.set(file.path, { content: new Uint8Array(file.data), mode: 0o600 });
          }),
        },
      };
      machines.set(id, { desktop, paused: false });
      return desktop;
    }),
    connect: vi.fn(async (id) => {
      const machine = machines.get(id);
      if (!machine) throw new SandboxNotFoundError(`Sandbox ${id} not found`);
      machine.paused = false;
      return machine.desktop;
    }),
    pause: vi.fn(async (id) => {
      const machine = machines.get(id);
      if (!machine) throw new SandboxNotFoundError(`Sandbox ${id} not found`);
      machine.paused = true;
    }),
    kill: vi.fn(async (id) => machines.delete(id)),
  };
  const provider = new NovitaSandboxProvider({ apiKey: "test-novita-key" }, sdk);
  return { provider, sdk, machines };
}
