import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactPut,
  ArtifactStore,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

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

  async put(artifact: ArtifactPut, context: AdapterContext) {
    const id = randomUUID();
    const dir = path.join(this.root, "artifacts", context.spaceId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, id);
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

  async get(id: string, context: AdapterContext) {
    const handle = await open(
      path.join(this.root, "artifacts", context.spaceId, id),
      constants.O_RDONLY | O_NOFOLLOW,
    );
    try {
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  async remove(id: string, context: AdapterContext) {
    await rm(path.join(this.root, "artifacts", context.spaceId, id), { force: true });
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
