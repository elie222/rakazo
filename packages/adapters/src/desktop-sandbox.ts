import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import {
  applyPlaceholderAction,
  boundedComputerActions,
  normalizeWorkspacePath,
  placeholderObservation,
} from "./computer-support.js";

interface DesktopBox {
  ref: ComputerRef;
  home: string;
  running: boolean;
  screen: string;
}

export class DesktopSandboxProvider implements SandboxProvider {
  readonly boxes = new Map<string, DesktopBox>();

  constructor(private readonly opts: { root?: string; hostRoots?: string[] } = {}) {}

  describe() {
    return {
      id: "desktop",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: false,
        pty: true,
        snapshots: true,
        takeover: false,
        persistentHome: true,
        multiScreen: false,
      },
    };
  }

  async provision(
    request: { botId: string; homePath: string },
    _context: AdapterContext,
  ): Promise<ComputerRef> {
    const home = path.resolve(
      this.opts.root ?? path.join(process.cwd(), "data"),
      "desktop-computers",
      request.botId,
    );
    const existing = [...this.boxes.values()].find(
      (box) => box.ref.botId === request.botId || box.home === home,
    );
    if (existing) {
      existing.running = true;
      return { ...existing.ref, fresh: false };
    }
    const id = `desktop-${request.botId}`;
    await mkdir(home, { recursive: true });
    const ref: ComputerRef = {
      id,
      botId: request.botId,
      kind: "desktop",
      providerRef: home,
      fresh: true,
    };
    this.boxes.set(id, {
      ref,
      home,
      running: true,
      screen: "ready",
    });
    return ref;
  }

  async prepare(_computer: ComputerRef, _context: AdapterContext): Promise<void> {}

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const box = this.boxFor(computer);
    if (!box) {
      yield { type: "stderr", data: "computer not found" };
      yield { type: "exit", code: 1 };
      return;
    }
    const cwd = resolveExecuteCwd(request.cwd, box.home);
    if (!allowedPath(cwd, this.allowedRoots(box.home))) {
      yield { type: "stderr", data: "path is outside this computer's home" };
      yield { type: "exit", code: 1 };
      return;
    }
    await mkdir(cwd, { recursive: true });
    const argv = request.argv.length ? request.argv : ["echo", "ready"];
    const result = await runCommand(
      argv,
      cwd,
      boundedSandboxCommandTimeoutMs(request.timeoutMs),
      context.signal,
    );
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    yield { type: "exit", code: result.code };
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<ScreenSession> {
    return {
      url: `desktop://screen/${computer.id}`,
      mimeType: "text/plain",
      close: async () => undefined,
    };
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    const box = this.boxFor(computer);
    if (box) applyPlaceholderAction(box, input);
  }

  async observe(computer: ComputerRef) {
    return placeholderObservation(this.requiredBox(computer).screen);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, _context: AdapterContext) {
    const box = this.requiredBox(computer);
    const actions = boundedComputerActions(request.actions);
    for (const action of actions) applyPlaceholderAction(box, action);
    return {
      completed: actions.length,
      ...(request.observe === false ? {} : { observation: await this.observe(computer) }),
    };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    _context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const box = this.requiredBox(computer);
    const relative = normalizeWorkspacePath(directory);
    const target = await localWorkspaceTarget(box.home, relative, true);
    const entries = await readdir(target, { withFileTypes: true });
    const listed = await Promise.all(
      entries.map(async (entry) => {
        const child = await localWorkspaceTarget(
          box.home,
          relative ? `${relative}/${entry.name}` : entry.name,
          true,
        );
        const info = await stat(child);
        return {
          path: normalizeWorkspacePath(relative ? `${relative}/${entry.name}` : entry.name),
          kind: info.isDirectory() ? ("dir" as const) : ("file" as const),
          size: info.size,
          ...(info.isFile() && info.mode & 0o100 ? { executable: true } : {}),
        };
      }),
    );
    return listed;
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    _context?: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const box = this.requiredBox(computer);
    const target = await localWorkspaceTarget(box.home, filePath, true);
    const info = await stat(target);
    if (options?.maxBytes !== undefined && info.size > options.maxBytes) {
      throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
    }
    return new Uint8Array(await readFile(target));
  }

  async writeFile(computer: ComputerRef, file: PortableFile) {
    const box = this.requiredBox(computer);
    const target = await localWorkspaceTarget(box.home, file.path, false);
    await mkdir(path.dirname(target), { recursive: true });
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      file.executable ? 0o700 : 0o600,
    );
    try {
      await handle.writeFile(file.content);
      if (file.executable) await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }

  async *exportWorkspace(computer: ComputerRef): AsyncIterable<PortableFile> {
    const box = this.requiredBox(computer);
    yield* walkDesktopWorkspace(box.home, "");
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    _context: AdapterContext,
  ) {
    for await (const file of files) await this.writeFile(computer, file);
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    return { id: `desktop-snap-${computer.id}`, createdAt: new Date().toISOString() };
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const box = this.boxFor(computer);
    if (box) box.running = false;
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const box = this.boxFor(computer);
    if (box) this.boxes.delete(box.ref.id);
    this.boxes.delete(computer.id);
    if (box && this.opts.root) {
      await writeFile(path.join(box.home, ".stopped"), new Date().toISOString(), "utf8").catch(
        () => undefined,
      );
    }
    if (box && !this.opts.root) {
      await rm(box.home, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private boxFor(computer: ComputerRef): DesktopBox | undefined {
    const existing = this.boxes.get(computer.id);
    if (existing) return existing;
    for (const box of this.boxes.values()) {
      if (box.ref.botId === computer.botId || box.home === computer.providerRef) return box;
    }
    if (!computer.providerRef) return undefined;
    const box: DesktopBox = {
      ref: computer,
      home: path.resolve(computer.providerRef),
      running: true,
      screen: "ready",
    };
    this.boxes.set(computer.id, box);
    return box;
  }

  private requiredBox(computer: ComputerRef): DesktopBox {
    const box = this.boxFor(computer);
    if (!box) throw new Error("computer not found");
    return box;
  }

  private allowedRoots(home: string) {
    return [home, ...(this.opts.hostRoots ?? [])];
  }
}

async function localWorkspaceTarget(home: string, relative: string, mustExist: boolean) {
  const normalized = normalizeWorkspacePath(relative);
  const candidate = path.resolve(home, normalized);
  if (!allowedPath(candidate, [home])) throw new Error("Path escapes the computer workspace");
  if (!mustExist) {
    const parent = path.dirname(candidate);
    await mkdir(parent, { recursive: true });
    const resolvedParent = await realpath(parent);
    if (!allowedPath(resolvedParent, [home]))
      throw new Error("Path escapes the computer workspace");
    return path.join(resolvedParent, path.basename(candidate));
  }
  const resolved = await realpath(candidate);
  if (!allowedPath(resolved, [home])) throw new Error("Path escapes the computer workspace");
  return resolved;
}

async function* walkDesktopWorkspace(home: string, directory: string): AsyncIterable<PortableFile> {
  const target = await localWorkspaceTarget(home, directory, true);
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const relative = normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name);
    const child = await localWorkspaceTarget(home, relative, true).catch(() => null);
    if (!child) continue;
    const info = await stat(child);
    if (info.isDirectory()) yield* walkDesktopWorkspace(home, relative);
    else if (info.isFile()) {
      yield {
        path: relative,
        content: new Uint8Array(await readFile(child)),
        executable: Boolean(info.mode & 0o100),
      };
    }
  }
}

function resolveExecuteCwd(requestCwd: string | undefined, home: string) {
  if (!requestCwd || requestCwd === "/home/rakazo" || requestCwd === "/home/user") return home;
  return path.resolve(home, requestCwd);
}

function allowedPath(target: string, roots: string[]) {
  const resolved = path.resolve(target);
  return roots.some((root) => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

function runCommand(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: process.env,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const terminate = (message: string, code: number) => {
      killProcessTree(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ stdout, stderr: appendLine(stderr, message), code });
    };
    const abort = () => terminate("command aborted", 130);
    const timeout = setTimeout(
      () => terminate(`command timed out after ${timeoutMs} ms`, 124),
      timeoutMs,
    );
    timeout.unref?.();
    signal.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (argv[0] === "echo") {
        finish({ stdout: `${argv.slice(1).join(" ")}\n`, stderr: "", code: 0 });
        return;
      }
      finish({ stdout: "", stderr: error.message, code: 1 });
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code: code ?? 0 });
    });
    if (signal.aborted) abort();
  });
}

function killProcessTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process exited between the timeout and termination attempt.
    }
  }
}

function appendLine(existing: string, message: string) {
  return `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${message}\n`;
}
