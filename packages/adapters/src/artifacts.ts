import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactPut,
  ArtifactStore,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";

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
    await writeFile(file, artifact.bytes);
    return { id, hash: String(artifact.bytes.byteLength) };
  }

  async get(id: string, context: AdapterContext) {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(path.join(this.root, "artifacts", context.spaceId, id)));
  }

  async remove(id: string, context: AdapterContext) {
    const { rm } = await import("node:fs/promises");
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
