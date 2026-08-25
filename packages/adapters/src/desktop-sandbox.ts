import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
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
import { isAllowedDesktopPath, normalizeDesktopWorkspacePath } from "./desktop-sandbox-paths.js";
import {
  createExclusiveChildViaDirectoryFdWin32,
  mkdirChildViaDirectoryFdWin32,
  openChildDirectoryViaDirectoryFdWin32,
  openExistingChildViaDirectoryFdWin32,
  pathFromDirectoryFd,
  type Win32FileHandle,
  win32NtRelativeAvailable,
} from "./desktop-sandbox-win32-path.js";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Node FileHandle or Win32 duck-typed handle opened relative to a parent directory. */
type ContainedHandle = Awaited<ReturnType<typeof open>> | Win32FileHandle;

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
    if (!isAllowedDesktopPath(cwd, this.allowedRoots(box.home))) {
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
    const handle = await openContainedWorkspaceFile(
      box.home,
      target,
      file.executable ? 0o700 : 0o600,
    );
    try {
      await handle.truncate(0);
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
  const normalized = normalizeDesktopWorkspacePath(relative);
  const candidate = path.resolve(home, normalized);
  if (!isAllowedDesktopPath(candidate, [home]))
    throw new Error("Path escapes the computer workspace");
  const resolvedHome = await realpath(home);
  if (!mustExist) {
    // Walk/create parents from a held directory fd so a junction swap cannot
    // redirect mkdir outside the workspace between validation and creation.
    const segments = normalized.split(/[/\\]/u).filter(Boolean);
    let current = resolvedHome;
    let parentHandle: ContainedHandle = await open(
      current,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    const useWin32Relative = win32NtRelativeAvailable();
    try {
      for (const segment of segments.slice(0, -1)) {
        // Re-bind the held parent immediately before create so a junction swap cannot
        // redirect pathname mkdir outside the workspace.
        current = await assertContainedDirectoryHandle(parentHandle, current, resolvedHome);
        let created: { path: string; dev: number; ino: number } | undefined;
        try {
          if (useWin32Relative) {
            const createdPath = mkdirChildViaDirectoryFdWin32(parentHandle.fd, segment);
            if (createdPath) {
              const createdStat = await stat(createdPath).catch(() => undefined);
              if (createdStat?.isDirectory()) {
                created = { path: createdPath, dev: createdStat.dev, ino: createdStat.ino };
              }
            }
          } else {
            const viaDirFd = childPathViaDirFd(parentHandle.fd, segment);
            const next = viaDirFd ?? path.join(current, segment);
            await mkdir(next);
            const createdStat = await stat(next);
            created = { path: next, dev: createdStat.dev, ino: createdStat.ino };
          }
        } catch (error) {
          if (!hasErrorCode(error, "EEXIST")) throw error;
        }
        try {
          let nextHandle: ContainedHandle;
          let before: { dev: number; ino: number; isDirectory(): boolean };
          let resolved: string;
          if (useWin32Relative) {
            nextHandle = openChildDirectoryViaDirectoryFdWin32(parentHandle.fd, segment);
            before = await nextHandle.stat();
            if (!before.isDirectory()) {
              await nextHandle.close().catch(() => undefined);
              throw new Error("Path escapes the computer workspace");
            }
            resolved = await assertContainedDirectoryHandle(
              nextHandle,
              path.join(current, segment),
              resolvedHome,
              before,
            );
          } else {
            const viaDirFd = childPathViaDirFd(parentHandle.fd, segment);
            const next = viaDirFd ?? path.join(current, segment);
            resolved = await realpath(next);
            before = await stat(resolved);
            if (!isAllowedDesktopPath(resolved, [resolvedHome]) || !before.isDirectory()) {
              throw new Error("Path escapes the computer workspace");
            }
            nextHandle = await open(resolved, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
            try {
              // Re-resolve after open so a junction swap cannot leave us holding an
              // outside directory while still trusting the earlier inside pathname.
              resolved = await assertContainedDirectoryHandle(
                nextHandle,
                resolved,
                resolvedHome,
                before,
              );
            } catch (error) {
              await nextHandle.close().catch(() => undefined);
              throw error;
            }
          }
          current = resolved;
          await parentHandle.close().catch(() => undefined);
          parentHandle = nextHandle;
        } catch (error) {
          // Only remove the directory inode we created; a swapped pathname must not
          // rmdir a different empty directory.
          if (created) {
            const present = await stat(created.path).catch(() => undefined);
            if (present && present.dev === created.dev && present.ino === created.ino) {
              await rmdir(created.path).catch(() => undefined);
            }
          }
          throw error;
        }
      }
      return path.join(current, segments.at(-1) ?? "");
    } finally {
      await parentHandle.close().catch(() => undefined);
    }
  }
  const resolved = await realpath(candidate);
  if (!isAllowedDesktopPath(resolved, [resolvedHome]))
    throw new Error("Path escapes the computer workspace");
  return resolved;
}

async function openContainedWorkspaceFile(home: string, target: string, mode: number) {
  const resolvedHome = await realpath(home);
  const parentPath = path.dirname(target);
  const name = path.basename(target);
  if (!name || name === "." || name === "..") {
    throw new Error("Path escapes the computer workspace");
  }

  const parentReal = await realpath(parentPath);
  if (!isAllowedDesktopPath(parentReal, [resolvedHome])) {
    throw new Error("Path escapes the computer workspace");
  }
  const parentBefore = await stat(parentReal);
  const parentHandle = await open(parentReal, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  const useWin32Relative = win32NtRelativeAvailable();

  let handle: ContainedHandle | undefined;
  let created = false;
  let openedPath = path.join(parentReal, name);
  try {
    // Bind the parent handle to a still-contained realpath. Otherwise a swap
    // after the first realpath can make inode checks agree on an outside dir
    // while pathname containment still sees the stale inside path.
    const containedParent = await assertContainedDirectoryHandle(
      parentHandle,
      parentReal,
      resolvedHome,
      parentBefore,
    );

    if (useWin32Relative) {
      // Open/create relative to the held parent HANDLE so a junction swap of the
      // parent pathname cannot redirect the write (true openat-style on Windows).
      try {
        handle = openExistingChildViaDirectoryFdWin32(parentHandle.fd, name);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
        handle = createExclusiveChildViaDirectoryFdWin32(parentHandle.fd, name);
        created = true;
        await handle.chmod(mode).catch(() => undefined);
      }
      try {
        openedPath = pathFromDirectoryFd(handle.fd);
      } catch {
        openedPath = path.join(containedParent, name);
      }
    } else {
      // Prefer directory-fd relative opens so a parent path swap cannot redirect creates.
      const viaDirFd = childPathViaDirFd(parentHandle.fd, name);
      openedPath = viaDirFd ?? path.join(containedParent, name);

      try {
        // Opening without O_TRUNC makes following a Windows reparse point non-destructive.
        handle = await open(openedPath, constants.O_WRONLY | O_NOFOLLOW);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
        handle = await open(
          openedPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
          mode,
        );
        created = true;
      }
    }

    const opened = await handle.stat({ bigint: true });
    // lstat the same child path we opened so a followed final symlink cannot match.
    const named = await lstat(openedPath, { bigint: true });
    if (
      !opened.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      opened.nlink !== 1n ||
      named.nlink !== 1n
    ) {
      throw new Error("Path escapes the computer workspace");
    }
    await assertContainedFileHandle(handle, resolvedHome, parentHandle, containedParent, name);
    return handle;
  } catch (error) {
    if (created && handle) {
      const createdStat = await handle.stat({ bigint: true }).catch(() => undefined);
      let cleanupPath = openedPath;
      if (useWin32Relative) {
        try {
          cleanupPath = pathFromDirectoryFd(handle.fd);
        } catch {
          // Keep openedPath when GetFinalPathName is unavailable.
        }
      }
      await handle.close().catch(() => undefined);
      handle = undefined;
      // Only unlink if the path still names the inode we created.
      if (createdStat) {
        const present = await lstat(cleanupPath, { bigint: true }).catch(() => undefined);
        if (present && present.dev === createdStat.dev && present.ino === createdStat.ino) {
          await unlink(cleanupPath).catch(() => undefined);
        }
      }
    } else {
      await handle?.close().catch(() => undefined);
    }
    throw error;
  } finally {
    await parentHandle.close().catch(() => undefined);
  }
}

async function assertContainedDirectoryHandle(
  handle: ContainedHandle,
  pathToRecheck: string,
  resolvedHome: string,
  expected?: { dev: number; ino: number },
) {
  const after = await handle.stat();
  if (
    !after.isDirectory() ||
    (expected && (after.dev !== expected.dev || after.ino !== expected.ino))
  ) {
    throw new Error("Path escapes the computer workspace");
  }
  // Prefer fd-bound realpath so containment cannot diverge from the open handle.
  const resolved = await realpathFromFd(handle.fd);
  if (resolved) {
    const named = await lstat(resolved).catch(() => undefined);
    if (named?.isSymbolicLink() || !isAllowedDesktopPath(resolved, [resolvedHome])) {
      throw new Error("Path escapes the computer workspace");
    }
    const fully = await realpath(resolved);
    if (!isAllowedDesktopPath(fully, [resolvedHome])) {
      throw new Error("Path escapes the computer workspace");
    }
    return fully;
  }
  // Pathname platforms: re-open the realpath immediately and require the same inode.
  const byPath = await realpath(pathToRecheck);
  if (!isAllowedDesktopPath(byPath, [resolvedHome])) {
    throw new Error("Path escapes the computer workspace");
  }
  const verify = await open(byPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    const verified = await verify.stat();
    if (!verified.isDirectory() || verified.dev !== after.dev || verified.ino !== after.ino) {
      throw new Error("Path escapes the computer workspace");
    }
  } finally {
    await verify.close().catch(() => undefined);
  }
  return byPath;
}

async function assertContainedFileHandle(
  handle: ContainedHandle,
  resolvedHome: string,
  parentHandle: ContainedHandle,
  parentPath: string,
  childName: string,
) {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isFile() || opened.nlink !== 1n) {
    throw new Error("Path escapes the computer workspace");
  }
  const resolved = await realpathFromFd(handle.fd);
  if (resolved) {
    const named = await lstat(resolved, { bigint: true });
    if (
      named.isSymbolicLink() ||
      !named.isFile() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      named.nlink !== 1n ||
      !isAllowedDesktopPath(resolved, [resolvedHome])
    ) {
      throw new Error("Path escapes the computer workspace");
    }
    const fully = await realpath(resolved);
    if (!isAllowedDesktopPath(fully, [resolvedHome])) {
      throw new Error("Path escapes the computer workspace");
    }
    return;
  }
  // Pathname platforms: the parent path must still name the held parent inode,
  // and re-opening the child through that path must yield the same file. A
  // junction swap for open + restore before the parent check would otherwise
  // leave an outside handle while the parent path looks inside again.
  const parentOpened = await parentHandle.stat();
  const parentNow = await stat(parentPath);
  if (
    !parentNow.isDirectory() ||
    parentNow.dev !== parentOpened.dev ||
    parentNow.ino !== parentOpened.ino
  ) {
    throw new Error("Path escapes the computer workspace");
  }
  const parentReal = await realpath(parentPath);
  if (!isAllowedDesktopPath(parentReal, [resolvedHome])) {
    throw new Error("Path escapes the computer workspace");
  }
  const verifyPath = path.join(parentReal, childName);
  const verify = await open(verifyPath, constants.O_RDONLY | O_NOFOLLOW);
  try {
    const verified = await verify.stat({ bigint: true });
    const named = await lstat(verifyPath, { bigint: true });
    // Re-stat the write handle last so a hardlink planted during verify cannot
    // make an outside inode appear to live under the restored parent.
    const again = await handle.stat({ bigint: true });
    if (
      !verified.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      verified.dev !== opened.dev ||
      verified.ino !== opened.ino ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      verified.nlink !== 1n ||
      named.nlink !== 1n ||
      again.dev !== opened.dev ||
      again.ino !== opened.ino ||
      again.nlink !== 1n
    ) {
      throw new Error("Path escapes the computer workspace");
    }
  } finally {
    await verify.close().catch(() => undefined);
  }
}

function childPathViaDirFd(fd: number, name: string) {
  if (process.platform === "linux") return `/proc/self/fd/${fd}/${name}`;
  return undefined;
}

async function realpathFromFd(fd: number) {
  if (process.platform === "linux") return realpath(`/proc/self/fd/${fd}`);
  if (process.platform === "win32") {
    try {
      return pathFromDirectoryFd(fd);
    } catch {
      // Hosts that only pretend to be win32 (unit tests) lack the Win32 APIs.
      return undefined;
    }
  }
  return undefined;
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
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
