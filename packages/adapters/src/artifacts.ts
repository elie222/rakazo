import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactPut,
  ArtifactStore,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  describe() {
    return {
      id: "local-artifacts",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { stream: true },
    };
  }

  private directory(context: AdapterContext): string {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}$/.test(context.spaceId)) {
      throw new Error("Invalid artifact space reference");
    }
    return path.join(this.root, "artifacts", context.spaceId);
  }

  private async artifactPath(id: string, context: AdapterContext): Promise<string> {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}$/.test(id)) {
      throw new Error("Invalid artifact storage reference");
    }
    const directory = this.directory(context);
    const rootInfo = await lstat(this.root);
    const root = await realpath(this.root).catch((error: unknown) => {
      if (rootInfo.isSymbolicLink()) throw new Error("Invalid artifact storage directory");
      throw error;
    });
    // Identify dangling scope symlinks before realpath can report them as missing.
    for (const candidate of [
      path.join(root, "artifacts"),
      path.join(root, "artifacts", context.spaceId),
    ]) {
      if ((await lstat(candidate)).isSymbolicLink()) {
        throw new Error("Invalid artifact storage directory");
      }
    }
    if ((await realpath(directory)) !== path.join(root, "artifacts", context.spaceId)) {
      throw new Error("Invalid artifact storage directory");
    }
    return path.join(directory, id);
  }

  async put(artifact: ArtifactPut, context: AdapterContext) {
    const id = randomUUID();
    const dir = this.directory(context);
    await mkdir(dir, { recursive: true });
    const file = await this.artifactPath(id, context);
    const handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(artifact.bytes);
    } finally {
      await handle.close();
    }
    return { id, hash: String(artifact.bytes.byteLength) };
  }

  async get(id: string, context: AdapterContext, options?: { maxBytes: number }) {
    const maxBytes = options?.maxBytes;
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new Error("Invalid artifact byte limit");
    }
    context.signal?.throwIfAborted();
    const handle = await open(
      await this.artifactPath(id, context),
      constants.O_RDONLY | O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Artifact is not a regular file");
      if (maxBytes === undefined) return new Uint8Array(await handle.readFile());
      if (info.size > maxBytes) throw new Error("Artifact exceeds the byte limit");
      // A size check alone races with growth. Never read more than the authorized bound + 1.
      const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
      let size = 0;
      while (size < bytes.length) {
        context.signal?.throwIfAborted();
        const next = await handle.read(bytes, size, bytes.length - size, size);
        if (!next.bytesRead) break;
        size += next.bytesRead;
      }
      if (size > maxBytes || size > info.size) throw new Error("Artifact exceeds the byte limit");
      return new Uint8Array(bytes.subarray(0, size));
    } finally {
      await handle.close();
    }
  }

  async remove(id: string, context: AdapterContext) {
    try {
      await rm(await this.artifactPath(id, context), { force: true });
    } catch (error) {
      // artifactPath validates both identifiers before any filesystem operation.
      if (!isMissingPath(error)) throw error;
    }
  }
}

export class CapturingNotificationProvider implements NotificationProvider {
  readonly sent: NotificationMessage[] = [];

  describe() {
    return {
      id: "capturing",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { push: false, email: false },
    };
  }

  async send(message: NotificationMessage, _context: AdapterContext): Promise<void> {
    this.sent.push(message);
  }
}
