import type { ArtifactStore } from "@rakazo/adapter-kit";
import {
  TOOL_FILE_IDLE_TTL_MS,
  TOOL_FILE_URL_MAX_USES,
  TOOL_FILE_URL_TTL_MS,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createToolFileStore,
  hashToolFileToken,
  TOOL_FILE_DOWNLOAD_PATH,
  ToolFileNotFoundError,
  ToolFileTooLargeError,
  toolFileMimeType,
  toolFileName,
  toolFileSweeper,
} from "./tool-files.js";

type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((part) => matches(row, part));
    const value = row[key];
    if (condition === null) return value === null || value === undefined;
    if (condition instanceof Date || typeof condition !== "object") return same(value, condition);
    const ops = condition as Record<string, unknown>;
    if ("gt" in ops && !(value !== null && (value as number) > (ops.gt as number))) return false;
    if ("lte" in ops && !(value !== null && (value as number) <= (ops.lte as number))) return false;
    if ("in" in ops && !(ops.in as unknown[]).includes(value)) return false;
    if ("notIn" in ops && (ops.notIn as unknown[]).includes(value)) return false;
    return true;
  });
}

/** Just enough of Prisma for the store: artifacts, tokens, and the token redemption. */
function fakePrisma() {
  const artifacts = new Map<string, Row>();
  const tokens = new Map<string, Row>();
  const contexts: Array<string | undefined> = [];
  let next = 0;
  const seen = () => {
    const context = currentDbContext();
    contexts.push(context?.kind === "tenant" ? `tenant:${context.spaceId}` : context?.kind);
  };
  const prisma = {
    artifact: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        seen();
        const row = { ...data, id: `tf${++next}`, createdAt: new Date() };
        artifacts.set(row.id, row);
        return { ...row };
      }),
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        seen();
        const row = [...artifacts.values()].find((item) => matches(item, where));
        return row ? { ...row } : null;
      }),
      findMany: vi.fn(async ({ where, take }: { where: Where; take?: number }) => {
        seen();
        return [...artifacts.values()]
          .filter((item) => matches(item, where))
          .slice(0, take)
          .map((row) => ({ ...row }));
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
        seen();
        let count = 0;
        for (const row of artifacts.values())
          if (matches(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        seen();
        let count = 0;
        for (const row of [...artifacts.values()])
          if (matches(row, where)) {
            artifacts.delete(row.id);
            for (const token of [...tokens.values()])
              if (token.artifactId === row.id) tokens.delete(token.id);
            count += 1;
          }
        return { count };
      }),
    },
    toolFileDownloadToken: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        seen();
        const row = { ...data, id: `tk${++next}` };
        tokens.set(row.id, row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        seen();
        let count = 0;
        for (const row of [...tokens.values()])
          if (matches(row, where)) {
            tokens.delete(row.id);
            count += 1;
          }
        return { count };
      }),
    },
    // The download's atomic `UPDATE … SET usesLeft = usesLeft - 1 … RETURNING artifactId`.
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, tokenHash: string, now: Date) => {
      seen();
      const row = [...tokens.values()].find(
        (token) =>
          token.tokenHash === tokenHash &&
          (token.usesLeft as number) > 0 &&
          (token.expiresAt as Date) > now,
      );
      if (!row) return [];
      row.usesLeft = (row.usesLeft as number) - 1;
      return [{ artifactId: row.artifactId }];
    }),
  };
  return { prisma: prisma as unknown as PrismaClient, artifacts, tokens, contexts, mock: prisma };
}

function fakeArtifactStore() {
  const blobs = new Map<string, Uint8Array>();
  let next = 0;
  const failing = new Set<string>();
  const store = {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { stream: false },
    }),
    put: vi.fn(async ({ bytes }: { bytes: Uint8Array }) => {
      const id = `blob${++next}`;
      blobs.set(id, bytes);
      return { id, hash: String(bytes.byteLength) };
    }),
    get: vi.fn(async (id: string) => {
      const bytes = blobs.get(id);
      if (!bytes) throw new Error("missing blob");
      return bytes;
    }),
    remove: vi.fn(async (id: string) => {
      if (failing.has(id)) throw new Error("storage unavailable");
      blobs.delete(id);
    }),
  };
  return { store: store as unknown as ArtifactStore, blobs, failing, mock: store };
}

const owner = { spaceId: "space-1", userId: "user-1", botId: "bot-1" };
const bytes = new TextEncoder().encode("%PDF-1.7 invoice");
const HOUR = 60 * 60 * 1000;

function harness(maxBytes?: number) {
  const db = fakePrisma();
  const storage = fakeArtifactStore();
  const store = createToolFileStore({
    prisma: db.prisma,
    artifacts: storage.store,
    publicBaseUrl: "https://rakazo.example.test/",
    maxBytes,
  });
  const create = () =>
    store.create({
      ...owner,
      runId: "run-1",
      name: "invoice.pdf",
      mimeType: "application/pdf",
      bytes,
    });
  return { db, storage, store, create };
}

const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

describe("temporary tool files", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores the bytes as an artifact that expires three hours after it is made", async () => {
    const { db, storage, create } = harness();

    const file = await create();

    expect(file).toEqual({
      id: "tf1",
      name: "invoice.pdf",
      mimeType: "application/pdf",
      size: bytes.byteLength,
      expiresAt: new Date(Date.now() + TOOL_FILE_IDLE_TTL_MS),
    });
    expect(db.artifacts.get("tf1")).toMatchObject({
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      runId: "run-1",
      storageKey: "blob1",
    });
    expect(storage.blobs.get("blob1")).toEqual(bytes);
    // Writes run as the file's tenant, so row-level security keeps it in its Space.
    expect(db.contexts).toEqual(["tenant:space-1"]);
  });

  it("refuses a file over the limit without storing anything", async () => {
    const { storage, create } = harness(4);

    await expect(create()).rejects.toBeInstanceOf(ToolFileTooLargeError);
    expect(storage.mock.put).not.toHaveBeenCalled();
  });

  it("removes the stored bytes when the row cannot be written", async () => {
    const { db, storage, create } = harness();
    db.mock.artifact.create.mockRejectedValueOnce(new Error("database down"));

    await expect(create()).rejects.toThrow("database down");
    expect(storage.blobs.size).toBe(0);
  });

  it("serves a file only to its own space, user and bot", async () => {
    const { store, create } = harness();
    const file = await create();

    await expect(store.read(file.id, owner)).resolves.toMatchObject({ bytes });
    // A bot-less caller in the same space and user (an approval card) may use it.
    await expect(
      store.read(file.id, { spaceId: "space-1", userId: "user-1" }),
    ).resolves.toBeTruthy();
    for (const scope of [
      { ...owner, spaceId: "space-2" },
      { ...owner, userId: "user-2" },
      { ...owner, botId: "bot-2" },
    ]) {
      await expect(store.read(file.id, scope)).rejects.toBeInstanceOf(ToolFileNotFoundError);
      await expect(store.signedUrl(file.id, scope)).rejects.toBeInstanceOf(ToolFileNotFoundError);
      await expect(store.describe(file.id, scope)).resolves.toBeUndefined();
    }
    await expect(store.read("missing", owner)).rejects.toBeInstanceOf(ToolFileNotFoundError);
  });

  it("never serves a file people keep, only temporary ones", async () => {
    const { db, store, create } = harness();
    const file = await create();
    db.artifacts.get(file.id)!.expiresAt = null;

    await expect(store.read(file.id, owner)).rejects.toBeInstanceOf(ToolFileNotFoundError);
    await expect(store.describe(file.id, owner)).resolves.toBeUndefined();
  });

  it("pushes the expiry back three hours on every use, and describing it does not", async () => {
    const { store, create } = harness();
    const file = await create();

    vi.advanceTimersByTime(2 * HOUR);
    const described = await store.describe(file.id, owner);
    expect(described?.expiresAt).toEqual(file.expiresAt);

    const read = await store.read(file.id, owner);
    expect(read.file.expiresAt).toEqual(new Date(Date.now() + TOOL_FILE_IDLE_TTL_MS));

    vi.advanceTimersByTime(2.5 * HOUR);
    const linked = await store.signedUrl(file.id, owner);
    expect(linked.file.expiresAt).toEqual(new Date(Date.now() + TOOL_FILE_IDLE_TTL_MS));

    // Three idle hours after the last use, it is gone for every use.
    vi.advanceTimersByTime(3 * HOUR);
    await expect(store.read(file.id, owner)).rejects.toBeInstanceOf(ToolFileNotFoundError);
    await expect(store.signedUrl(file.id, owner)).rejects.toBeInstanceOf(ToolFileNotFoundError);
    await expect(store.describe(file.id, owner)).resolves.toBeUndefined();
  });

  it("sweeps expired files from storage and the database, once", async () => {
    const { db, storage, store, create } = harness();
    const expired = await create();
    await store.signedUrl(expired.id, owner);
    vi.advanceTimersByTime(HOUR);
    const alive = await create();
    vi.advanceTimersByTime(2.5 * HOUR);

    expect(await store.sweepExpired()).toBe(1);
    expect([...db.artifacts.keys()]).toEqual([alive.id]);
    expect([...storage.blobs.keys()]).toEqual(["blob2"]);
    expect(db.tokens.size).toBe(0);
    expect(db.contexts.at(-1)).toBe("system");

    expect(await store.sweepExpired()).toBe(0);
    expect([...db.artifacts.keys()]).toEqual([alive.id]);
  });

  it("counts each file once when two sweeps race", async () => {
    const { db, storage, store, create } = harness();
    for (let i = 0; i < 3; i += 1) await create();
    vi.advanceTimersByTime(TOOL_FILE_IDLE_TTL_MS + 1);

    const [a, b] = await Promise.all([store.sweepExpired(), store.sweepExpired()]);

    expect(a + b).toBe(3);
    expect(db.artifacts.size).toBe(0);
    expect(storage.blobs.size).toBe(0);
  });

  it("keeps a file whose bytes would not delete and removes it on a later sweep", async () => {
    const { db, storage, store, create } = harness();
    const file = await create();
    vi.advanceTimersByTime(TOOL_FILE_IDLE_TTL_MS + 1);
    storage.failing.add("blob1");

    expect(await store.sweepExpired()).toBe(0);
    expect(db.artifacts.has(file.id)).toBe(true);
    // Claimed for deletion: no use can bring it back.
    await expect(store.read(file.id, owner)).rejects.toBeInstanceOf(ToolFileNotFoundError);

    storage.failing.clear();
    expect(await store.sweepExpired()).toBe(1);
    expect(db.artifacts.size).toBe(0);
    expect(storage.blobs.size).toBe(0);
  });

  it("does not sweep a file a use kept alive", async () => {
    const { db, store, create } = harness();
    const file = await create();
    vi.advanceTimersByTime(2.9 * HOUR);
    await store.read(file.id, owner);
    vi.advanceTimersByTime(0.2 * HOUR);

    expect(await store.sweepExpired()).toBe(0);
    expect(db.artifacts.has(file.id)).toBe(true);
  });

  it("runs the sweep from the reconciler every ten minutes at most", async () => {
    const sweepExpired = vi.fn(async () => 0);
    const sweep = toolFileSweeper({ sweepExpired });

    await sweep();
    await sweep();
    vi.advanceTimersByTime(10 * 60 * 1000);
    await sweep();

    expect(sweepExpired).toHaveBeenCalledTimes(2);
  });

  describe("signed download links", () => {
    it("mints a link under the API origin whose token is stored only as a hash", async () => {
      const { db, store, create } = harness();
      const file = await create();

      const { url } = await store.signedUrl(file.id, owner);

      expect(url.startsWith(`https://rakazo.example.test${TOOL_FILE_DOWNLOAD_PATH}`)).toBe(true);
      const token = tokenOf(url);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect([...db.tokens.values()]).toEqual([
        expect.objectContaining({
          tokenHash: hashToolFileToken(token),
          artifactId: file.id,
          spaceId: "space-1",
          usesLeft: TOOL_FILE_URL_MAX_USES,
          expiresAt: new Date(Date.now() + TOOL_FILE_URL_TTL_MS),
        }),
      ]);
      expect(JSON.stringify([...db.tokens.values()])).not.toContain(token);
    });

    it("serves the file a few times and extends its expiry", async () => {
      const { store, create } = harness();
      const file = await create();
      const token = tokenOf((await store.signedUrl(file.id, owner)).url);

      vi.advanceTimersByTime(5 * 60 * 1000);
      const first = await store.download(token);
      expect(first?.bytes).toEqual(bytes);
      expect(first?.file.expiresAt).toEqual(new Date(Date.now() + TOOL_FILE_IDLE_TTL_MS));
      for (let use = 1; use < TOOL_FILE_URL_MAX_USES; use += 1)
        expect(await store.download(token)).toBeDefined();

      expect(await store.download(token)).toBeUndefined();
    });

    it("refuses an expired link, a wrong token, and a link to an expired file", async () => {
      const { db, store, create } = harness();
      const file = await create();
      const token = tokenOf((await store.signedUrl(file.id, owner)).url);

      expect(await store.download("not-a-token")).toBeUndefined();
      expect(await store.download("A".repeat(43))).toBeUndefined();
      vi.advanceTimersByTime(TOOL_FILE_URL_TTL_MS);
      expect(await store.download(token)).toBeUndefined();

      const fresh = tokenOf((await store.signedUrl(file.id, owner)).url);
      // The file expired (or a sweep claimed it) while its newest link is still valid.
      db.artifacts.get(file.id)!.expiresAt = new Date(Date.now() - 1);
      expect(await store.download(fresh)).toBeUndefined();
    });
  });
});

describe("tool file names and types", () => {
  it("keeps a plain name and drops folders and control characters", () => {
    expect(toolFileName("invoice.pdf")).toBe("invoice.pdf");
    expect(toolFileName("/tmp/out/../report.csv")).toBe("report.csv");
    expect(toolFileName("C:\\Users\\me\\photo.png")).toBe("photo.png");
    expect(toolFileName("bad\u0000\nname.txt")).toBe("badname.txt");
    expect(toolFileName("..")).toBe("file");
    expect(toolFileName("x".repeat(400))).toHaveLength(255);
  });

  it("serves a bare type, or octet-stream for anything else", () => {
    expect(toolFileMimeType("Image/PNG")).toBe("image/png");
    expect(toolFileMimeType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(toolFileMimeType("text/html\r\nSet-Cookie: x=1")).toBe("application/octet-stream");
    expect(toolFileMimeType("")).toBe("application/octet-stream");
  });
});
