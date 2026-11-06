import { TOOL_FILE_IDLE_TTL_MS } from "@rakazo/contracts";
import type { ToolFileRef, ToolFileScope, ToolFileStore } from "./tool-files.js";

type StoredFile = ToolFileRef & ToolFileScope & { bytes: Uint8Array; runId?: string | null };

/** An in-memory {@link ToolFileStore} for tests, with the real store's scope checks. */
export class FakeToolFileStore implements ToolFileStore {
  readonly files = new Map<string, StoredFile>();
  readonly urls: string[] = [];
  private seq = 0;

  constructor(private readonly options: { maxBytes?: number } = {}) {}

  async create(
    input: ToolFileScope & {
      runId?: string | null;
      name: string;
      mimeType: string;
      bytes: Uint8Array;
    },
  ): Promise<ToolFileRef> {
    if (this.options.maxBytes !== undefined && input.bytes.length > this.options.maxBytes) {
      const error = new Error(`File exceeds ${this.options.maxBytes} bytes`);
      error.name = "ToolFileTooLargeError";
      throw error;
    }
    const id = `tf${++this.seq}`;
    const file: StoredFile = {
      ...input,
      botId: input.botId ?? null,
      id,
      size: input.bytes.length,
      expiresAt: new Date(Date.now() + TOOL_FILE_IDLE_TTL_MS),
    };
    this.files.set(id, file);
    return this.ref(file);
  }

  async read(id: string, scope: ToolFileScope) {
    const file = this.usable(id, scope);
    if (!file) throw new Error(`Tool file ${id} not found`);
    return { file: this.ref(file), bytes: file.bytes };
  }

  async signedUrl(id: string, scope: ToolFileScope) {
    const file = this.usable(id, scope);
    if (!file) throw new Error(`Tool file ${id} not found`);
    const url = `https://files.rakazo.test/api/tool-files/${id}?token=signed-${id}-${this.urls.length + 1}`;
    this.urls.push(url);
    return { file: this.ref(file), url };
  }

  async describe(id: string, scope: ToolFileScope) {
    const file = this.usable(id, scope);
    return file ? this.ref(file) : undefined;
  }

  async sweepExpired(now = new Date()) {
    let removed = 0;
    for (const [id, file] of this.files)
      if (file.expiresAt <= now && this.files.delete(id)) removed += 1;
    return removed;
  }

  /** Make a file expire, as the idle TTL would. */
  expire(id: string): void {
    const file = this.files.get(id);
    if (file) file.expiresAt = new Date(0);
  }

  private usable(id: string, scope: ToolFileScope): StoredFile | undefined {
    const file = this.files.get(id);
    if (!file || file.expiresAt.getTime() <= Date.now()) return undefined;
    if (file.spaceId !== scope.spaceId || file.userId !== scope.userId) return undefined;
    if ((file.botId ?? null) !== (scope.botId ?? null)) return undefined;
    return file;
  }

  private ref(file: StoredFile): ToolFileRef {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      expiresAt: file.expiresAt,
    };
  }
}
