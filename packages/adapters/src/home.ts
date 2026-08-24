import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, AgentHomeStore, PortableFile } from "@rakazo/adapter-kit";

export class LocalAgentHomeStore implements AgentHomeStore {
  private readonly botWrites = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  describe() {
    return {
      id: "local-fs",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { revisions: false },
    };
  }

  private botDir(botId: string) {
    if (!botId || botId === "." || botId === ".." || path.basename(botId) !== botId) {
      throw new Error("Invalid bot id");
    }
    return path.join(this.root, "homes", botId);
  }

  pathFor(botId: string) {
    return path.resolve(this.botDir(botId));
  }

  async checkout(botId: string, dest: string, _context: AdapterContext): Promise<string> {
    await this.waitForBotWrite(botId);
    await this.recoverInterruptedCommit(botId);
    await mkdir(dest, { recursive: true });
    const src = this.botDir(botId);
    await mkdir(src, { recursive: true });
    await copyDir(src, dest);
    return "working";
  }

  async commit(botId: string, src: string, _context: AdapterContext): Promise<string> {
    return this.withBotWrite(botId, async () => {
      await this.recoverInterruptedCommit(botId);
      const dest = this.botDir(botId);
      const parent = path.dirname(dest);
      const staging = path.join(parent, `.${botId}.staging-${randomUUID()}`);
      const previous = `${dest}.previous`;
      await mkdir(parent, { recursive: true });
      await mkdir(staging, { recursive: true });
      try {
        await copyDir(src, staging);
        await rm(previous, { recursive: true, force: true });
        if (await pathExists(dest)) await rename(dest, previous);
        try {
          await rename(staging, dest);
        } catch (error) {
          if (!(await pathExists(dest)) && (await pathExists(previous))) {
            await rename(previous, dest).catch(() => undefined);
          }
          throw error;
        }
        await rm(previous, { recursive: true, force: true });
        return this.writeRevision(botId);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  async revise(botId: string): Promise<string> {
    return this.withBotWrite(botId, async () => this.writeRevision(botId));
  }

  async restore(
    botId: string,
    _revision: string,
    dest: string,
    context: AdapterContext,
  ): Promise<void> {
    await this.checkout(botId, dest, context);
  }

  async *exportHome(botId: string, _context: AdapterContext): AsyncIterable<PortableFile> {
    await this.waitForBotWrite(botId);
    await this.recoverInterruptedCommit(botId);
    const dir = this.botDir(botId);
    await mkdir(dir, { recursive: true });
    yield* walkFiles(dir, dir);
  }

  async readFile(
    botId: string,
    filePath: string,
    _context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<string> {
    await this.waitForBotWrite(botId);
    await this.recoverInterruptedCommit(botId);
    const full = await containedExistingPath(this.botDir(botId), filePath);
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (options?.maxBytes !== undefined) {
        const info = await handle.stat();
        if (info.size > options.maxBytes) {
          throw new Error(`agent home file exceeds ${options.maxBytes} bytes`);
        }
      }
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  async writeFile(
    botId: string,
    filePath: string,
    content: string,
    _context: AdapterContext,
  ): Promise<void> {
    await this.withBotWrite(botId, async () => {
      await this.recoverInterruptedCommit(botId);
      const full = await containedWritePath(this.botDir(botId), filePath);
      const handle = await open(
        full,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o666,
      );
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
    });
  }

  async list(botId: string, dirPath: string, _context: AdapterContext) {
    await this.waitForBotWrite(botId);
    await this.recoverInterruptedCommit(botId);
    const root = this.botDir(botId);
    const candidate = safeJoin(root, dirPath);
    const full = await ensureContainedDirectory(root, candidate);
    const entries = await readdir(full, { withFileTypes: true });
    const listed = await Promise.all(
      entries.map(async (entry) => {
        const child = await containedTarget(root, path.join(full, entry.name)).catch(() => null);
        if (!child) return null;
        const info = await stat(child);
        return {
          path: path.posix.join(dirPath.replace(/\\/g, "/"), entry.name),
          kind: info.isDirectory() ? ("dir" as const) : ("file" as const),
          size: info.size,
        };
      }),
    );
    return listed.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  private async writeRevision(botId: string) {
    const revision = `rev-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const directory = path.join(this.root, "home-revisions");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${botId}.txt`), revision, "utf8");
    return revision;
  }

  private async recoverInterruptedCommit(botId: string) {
    const dest = this.botDir(botId);
    const previous = `${dest}.previous`;
    if (!(await pathExists(dest)) && (await pathExists(previous))) await rename(previous, dest);
  }

  private async withBotWrite<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.botWrites.get(botId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Keep the chain alive even when a prior write rejects, so later writers are not stuck
    // behind a permanently rejected predecessor.
    const queued = previous.catch(() => undefined).then(() => current);
    this.botWrites.set(botId, queued);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.botWrites.get(botId) === queued) this.botWrites.delete(botId);
    }
  }

  private async waitForBotWrite(botId: string) {
    await (this.botWrites.get(botId) ?? Promise.resolve());
  }
}

export function resolveAgentHomePath(home: AgentHomeStore, homeKey: string, dataDir = "./data") {
  if (home instanceof LocalAgentHomeStore) return home.pathFor(homeKey);
  return path.resolve(dataDir, "homes", homeKey);
}

function safeJoin(root: string, rel: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, `.${path.sep}${rel.replace(/^\/+/, "")}`);
  assertContained(resolvedRoot, resolved);
  return resolved;
}

async function containedExistingPath(root: string, rel: string) {
  await mkdir(root, { recursive: true });
  const candidate = safeJoin(root, rel);
  return containedTarget(root, candidate);
}

async function containedWritePath(root: string, rel: string) {
  await mkdir(root, { recursive: true });
  const candidate = safeJoin(root, rel);
  const resolvedParent = await ensureContainedDirectory(root, path.dirname(candidate));
  try {
    return await containedTarget(root, path.join(resolvedParent, path.basename(candidate)));
  } catch (error) {
    if (isMissing(error)) return path.join(resolvedParent, path.basename(candidate));
    throw error;
  }
}

async function ensureContainedDirectory(root: string, candidate: string) {
  await mkdir(root, { recursive: true });
  const lexicalRoot = path.resolve(root);
  const lexicalCandidate = path.resolve(candidate);
  assertContained(lexicalRoot, lexicalCandidate);
  const resolvedRoot = await realpath(root);
  const relative = path.relative(lexicalRoot, lexicalCandidate);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    try {
      current = await realpath(next);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(next);
      current = await realpath(next);
    }
    assertContained(resolvedRoot, current);
    if (!(await stat(current)).isDirectory()) throw new Error("Path component is not a directory");
  }
  return current;
}

async function containedTarget(root: string, candidate: string) {
  const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(candidate)]);
  assertContained(resolvedRoot, resolvedTarget);
  return resolvedTarget;
}

function assertContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) return;
  throw new Error("Path escapes the bot home");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src: string, dest: string, sourceRoot = src, visited = new Set<string>()) {
  await mkdir(dest, { recursive: true });
  const current = await containedTarget(sourceRoot, src).catch(() => null);
  if (!current || visited.has(current)) return;
  visited.add(current);
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const from = await containedTarget(sourceRoot, path.join(current, entry.name)).catch(
      () => null,
    );
    if (!from) continue;
    const to = path.join(dest, entry.name);
    const info = await stat(from);
    if (info.isDirectory()) await copyDir(from, to, sourceRoot, visited);
    else if (info.isFile()) await writeFile(to, await readFile(from), { mode: info.mode & 0o777 });
  }
}

async function* walkFiles(
  root: string,
  current: string,
  outputPath = "",
  visited = new Set<string>(),
): AsyncGenerator<PortableFile> {
  const resolvedCurrent = await containedTarget(root, current).catch(() => null);
  if (!resolvedCurrent || visited.has(resolvedCurrent)) return;
  visited.add(resolvedCurrent);
  const entries = await readdir(resolvedCurrent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = await containedTarget(root, path.join(resolvedCurrent, entry.name)).catch(
      () => null,
    );
    if (!full) continue;
    const info = await stat(full);
    const portablePath = path.posix.join(outputPath, entry.name);
    if (info.isDirectory()) {
      yield* walkFiles(root, full, portablePath, visited);
    } else if (info.isFile()) {
      const content = await readFile(full);
      yield {
        path: portablePath,
        content: new Uint8Array(content),
        executable: Boolean(info.mode & 0o100),
      };
    }
  }
}
