import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import { ContentDecryptionError, ContentKeyRing, LocalKeyProvider } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAgentHomeStore } from "./home.js";
import {
  createAgentHomeStore,
  ObjectAgentHomeStore,
  PrismaAgentHomeRecords,
} from "./home-object-store.js";
import { MemoryObjectStorage } from "./object-storage.test-support.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface ComputerRow {
  id: string;
  spaceId: string;
  homeKey: string;
  homeStorageId: string | null;
  homeStorageKey: string | null;
  homeStorageRevision: string | null;
}

/** The slice of `prisma.computer` the records use, over an array of rows. */
function fakeComputers(rows: ComputerRow[]) {
  const matches = (row: ComputerRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([field, value]) => {
      const actual = row[field as keyof ComputerRow];
      if (value && typeof value === "object" && "in" in value)
        return (value.in as unknown[]).includes(actual);
      return actual === value;
    });
  const pick = (row: ComputerRow, select: Record<string, boolean>) =>
    Object.fromEntries(
      Object.keys(select).map((field) => [field, row[field as keyof ComputerRow]]),
    );
  return {
    computer: {
      findUnique: async ({
        where,
        select,
      }: {
        where: Record<string, unknown>;
        select: Record<string, boolean>;
      }) => {
        const row = rows.find((candidate) => matches(candidate, where));
        return row ? pick(row, select) : null;
      },
      findMany: async ({
        where,
        select,
      }: {
        where: Record<string, unknown>;
        select: Record<string, boolean>;
      }) => rows.filter((row) => matches(row, where)).map((row) => pick(row, select)),
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<ComputerRow>;
      }) => {
        const updated = rows.filter((row) => matches(row, where));
        for (const row of updated) Object.assign(row, data);
        return { count: updated.length };
      },
    },
  } as unknown as Pick<PrismaClient, "computer">;
}

function memoryRing() {
  const keys: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) => keys.filter((row) => row.spaceId === spaceId),
    byId: async (id) => keys.find((row) => row.id === id),
    insert: async (record) => {
      keys.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => [],
  };
  return new ContentKeyRing(new LocalKeyProvider([{ id: "k1", key: randomBytes(32) }]), store);
}

async function setup(homeKeys = ["bot-1"]) {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-object-homes-"));
  dirs.push(root);
  const rows: ComputerRow[] = homeKeys.map((homeKey, index) => ({
    id: `computer-${index + 1}`,
    spaceId: "space-1",
    homeKey,
    homeStorageId: null,
    homeStorageKey: null,
    homeStorageRevision: null,
  }));
  const storage = new MemoryObjectStorage();
  const records = new PrismaAgentHomeRecords(fakeComputers(rows), memoryRing());
  const store = new ObjectAgentHomeStore(root, storage, records);
  /** Another API or worker host: same bucket and database, its own empty cache. */
  const otherHost = async () => {
    const otherRoot = await mkdtemp(path.join(tmpdir(), "rakazo-object-homes-"));
    dirs.push(otherRoot);
    return new ObjectAgentHomeStore(otherRoot, storage, records);
  };
  return { root, rows, storage, records, store, otherHost };
}

/** A sandbox export staged for `commit`. */
async function staged(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-object-staging-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

async function exported(store: LocalAgentHomeStore, homeKey: string) {
  const files: Record<string, string> = {};
  for await (const file of store.exportHome(homeKey, context))
    files[file.path] = Buffer.from(file.content).toString("utf8");
  return files;
}

describe("ObjectAgentHomeStore", () => {
  it("stores each revision as one encrypted object under an opaque key", async () => {
    const { store, storage, rows } = await setup(["bot-named-ada"]);
    const revision = await store.commit(
      "bot-named-ada",
      await staged({
        ".browser-profiles/default/Cookies": "session=very-secret-cookie",
        "notes/todo.txt": "write the report",
      }),
      context,
    );

    expect(storage.objects.size).toBe(1);
    const [key, object] = [...storage.objects][0]!;
    expect(key).toBe(`homes/${rows[0]!.homeStorageId}/${revision}`);
    expect(key).not.toContain("bot-named-ada");
    expect(key).not.toContain("space-1");
    expect(object!.bytes.includes(Buffer.from("very-secret-cookie"))).toBe(false);
    expect(object!.bytes.includes(Buffer.from("todo.txt"))).toBe(false);
    expect(rows[0]!.homeStorageRevision).toBe(revision);
    expect(rows[0]!.homeStorageKey).toMatch(/^rkz1:/);
  });

  it("restores a home on a host whose cache is empty", async () => {
    const { store, otherHost } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "one", "dir/b.txt": "two" }), context);

    const other = await otherHost();
    expect(await exported(other, "bot-1")).toEqual({ "a.txt": "one", "dir/b.txt": "two" });
    expect(await other.readFile("bot-1", "dir/b.txt", context)).toBe("two");
  });

  it("downloads again after the cache is evicted, and replaces a stale cache", async () => {
    const { root, store, otherHost } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "first" }), context);
    await rm(path.join(root, "homes"), { recursive: true });
    await rm(path.join(root, "home-revisions"), { recursive: true });
    expect(await store.readFile("bot-1", "a.txt", context)).toBe("first");

    const other = await otherHost();
    await other.commit("bot-1", await staged({ "a.txt": "second" }), context);
    expect(await store.readFile("bot-1", "a.txt", context)).toBe("second");
  });

  it("downloads again when the cache directory is gone but its marker remains", async () => {
    const { root, store, storage, rows } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "stored" }), context);
    await rm(path.join(root, "homes"), { recursive: true });
    expect(await store.readFile("bot-1", "a.txt", context)).toBe("stored");

    // A save of a missing cache must not replace the stored home with an empty one.
    await rm(path.join(root, "homes"), { recursive: true });
    await expect(store.revise("bot-1")).rejects.toThrow(/older than its stored revision/);
    expect([...storage.objects.keys()]).toEqual([
      `homes/${rows[0]!.homeStorageId}/${rows[0]!.homeStorageRevision}`,
    ]);
  });

  it("does not let a save that started before a newer one replace it", async () => {
    const { root, storage, records, otherHost } = await setup();
    let interleave: (() => Promise<unknown>) | undefined;
    const racing = new ObjectAgentHomeStore(root, storage, {
      ...records,
      load: (homeKey) => records.load(homeKey),
      advance: (...args) => records.advance(...args),
      revisions: (ids) => records.revisions(ids),
      create: async (homeKey) => {
        await interleave?.();
        return records.create(homeKey);
      },
    });
    await racing.commit("bot-1", await staged({ "a.txt": "first" }), context);
    const other = await otherHost();
    interleave = async () => {
      interleave = undefined;
      await other.commit("bot-1", await staged({ "a.txt": "newer" }), context);
    };

    await expect(racing.revise("bot-1")).rejects.toThrow(/saved elsewhere/);
    expect(await (await otherHost()).readFile("bot-1", "a.txt", context)).toBe("newer");
    expect(storage.objects.size).toBe(1);
  });

  it("keeps the upload when recording its revision fails without a reply", async () => {
    const { root, storage, records, rows } = await setup();
    const store = new ObjectAgentHomeStore(root, storage, {
      load: (homeKey) => records.load(homeKey),
      create: (homeKey) => records.create(homeKey),
      revisions: (ids) => records.revisions(ids),
      // The update commits, then the connection drops before the reply.
      advance: async (...args) => {
        await records.advance(...args);
        throw new Error("connection terminated");
      },
    });
    await expect(store.commit("bot-1", await staged({ "a.txt": "x" }), context)).rejects.toThrow(
      "connection terminated",
    );
    expect([...storage.objects.keys()]).toEqual([
      `homes/${rows[0]!.homeStorageId}/${rows[0]!.homeStorageRevision}`,
    ]);
  });

  it("keeps only the current revision once a newer one is saved", async () => {
    const { store, storage, rows } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "first" }), context);
    const second = await store.commit("bot-1", await staged({ "a.txt": "second" }), context);
    expect([...storage.objects.keys()]).toEqual([`homes/${rows[0]!.homeStorageId}/${second}`]);
  });

  it("saves the cached copy a Docker computer changed in place", async () => {
    const { store, otherHost } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "booted" }), context);
    await writeFile(path.join(store.pathFor("bot-1"), "a.txt"), "edited by the computer");
    await store.revise("bot-1");
    expect(await (await otherHost()).readFile("bot-1", "a.txt", context)).toBe(
      "edited by the computer",
    );
  });

  it("refuses to save a stale cache over a newer stored revision", async () => {
    const { store, otherHost } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "first" }), context);
    await (await otherHost()).commit("bot-1", await staged({ "a.txt": "newer" }), context);
    await expect(store.revise("bot-1")).rejects.toThrow(/older than its stored revision/);
  });

  it("fails closed when a stored object is modified", async () => {
    const { store, storage, otherHost } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "original" }), context);
    const object = [...storage.objects.values()][0]!;
    object.bytes[object.bytes.length - 20]! ^= 1;

    const other = await otherHost();
    await expect(other.readFile("bot-1", "a.txt", context)).rejects.toThrow(ContentDecryptionError);
  });

  it("rejects another home's object, or an older revision, moved into place", async () => {
    const { store, storage, rows, otherHost } = await setup(["bot-1", "bot-2"]);
    await store.commit("bot-1", await staged({ "a.txt": "bot one" }), context);
    const older = [...storage.objects.values()][0]!.bytes;
    await store.commit("bot-1", await staged({ "a.txt": "bot one, later" }), context);
    await store.commit("bot-2", await staged({ "a.txt": "bot two" }), context);
    const keyOf = (index: number) =>
      `homes/${rows[index]!.homeStorageId}/${rows[index]!.homeStorageRevision}`;

    // Another home's object under this home's key: a different data key.
    storage.objects.set(keyOf(1), { ...storage.objects.get(keyOf(0))! });
    await expect((await otherHost()).readFile("bot-2", "a.txt", context)).rejects.toThrow(
      ContentDecryptionError,
    );
    // This home's older revision under its current key: bound to its own revision.
    storage.objects.set(keyOf(0), { bytes: older, lastModified: new Date() });
    await expect((await otherHost()).readFile("bot-1", "a.txt", context)).rejects.toThrow(
      ContentDecryptionError,
    );
  });

  it("cannot unwrap a home key copied to another computer", async () => {
    const { store, rows, records } = await setup(["bot-1", "bot-2"]);
    await store.commit("bot-1", await staged({ "a.txt": "x" }), context);
    Object.assign(rows[1]!, {
      homeStorageId: rows[0]!.homeStorageId,
      homeStorageKey: rows[0]!.homeStorageKey,
      homeStorageRevision: rows[0]!.homeStorageRevision,
    });
    rows[0]!.homeStorageId = "moved-away";
    await expect(records.load("bot-2")).rejects.toThrow(ContentDecryptionError);
  });

  it("deletes the objects of a deleted computer, and stale revisions, when sweeping", async () => {
    const { store, storage, rows } = await setup(["bot-1", "bot-2"]);
    await store.commit("bot-1", await staged({ "a.txt": "keep" }), context);
    await store.commit("bot-2", await staged({ "a.txt": "delete" }), context);
    const kept = `homes/${rows[0]!.homeStorageId}/${rows[0]!.homeStorageRevision}`;
    const crashed = `homes/${rows[0]!.homeStorageId}/rev-crashed`;
    storage.objects.set(crashed, { bytes: Buffer.from("x"), lastModified: new Date(0) });
    const inProgress = `homes/${rows[0]!.homeStorageId}/rev-in-progress`;
    storage.objects.set(inProgress, { bytes: Buffer.from("x"), lastModified: new Date() });
    // Deleting the bot deletes its computer row, and with it the wrapped data key.
    rows.splice(1, 1);

    expect(await store.sweep()).toBe(2);
    expect([...storage.objects.keys()].sort()).toEqual([kept, inProgress].sort());
  });

  it("deletes nothing when the database knows none of the stored homes", async () => {
    const { store, storage, rows } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "keep" }), context);
    rows.splice(0);
    expect(await store.sweep()).toBe(0);
    expect(storage.objects.size).toBe(1);
  });

  it("migrates local homes once, verifies them and keeps the local copy", async () => {
    const { root, store, storage, otherHost } = await setup(["bot-1", "bot-2"]);
    const plain = new LocalAgentHomeStore(root);
    await plain.commit("bot-1", await staged({ "a.txt": "local one" }), context);
    await plain.commit("bot-2", await staged({ "b.txt": "local two" }), context);
    await plain.commit("orphan", await staged({ "c.txt": "no computer" }), context);
    expect(await store.localHomes()).toEqual(["bot-1", "bot-2", "orphan"]);

    expect(await store.migrateLocal("bot-1", { dryRun: true })).toBe("would-upload");
    expect(storage.objects.size).toBe(0);
    const first = await Promise.all(
      (await store.localHomes()).map((key) => store.migrateLocal(key)),
    );
    expect(first).toEqual(["uploaded", "uploaded", "no-computer"]);
    const second = await Promise.all(
      (await store.localHomes()).map((key) => store.migrateLocal(key)),
    );
    expect(second).toEqual(["stored", "stored", "no-computer"]);

    expect(storage.objects.size).toBe(2);
    expect(await readFile(path.join(root, "homes/bot-1/a.txt"), "utf8")).toBe("local one");
    expect(await exported(await otherHost(), "bot-2")).toEqual({ "b.txt": "local two" });
  });

  it("records a migrated home only after its upload verifies", async () => {
    const { root, storage, records, rows } = await setup();
    await new LocalAgentHomeStore(root).commit("bot-1", await staged({ "a.txt": "x" }), context);
    const corrupting = Object.assign(Object.create(storage) as MemoryObjectStorage, {
      async *get(key: string) {
        const bytes = Buffer.from(storage.objects.get(key)!.bytes);
        bytes[bytes.length - 20]! ^= 1;
        yield bytes;
      },
    });

    await expect(
      new ObjectAgentHomeStore(root, corrupting, records).migrateLocal("bot-1"),
    ).rejects.toThrow(ContentDecryptionError);
    expect(rows[0]!.homeStorageRevision).toBeNull();
    expect(storage.objects.size).toBe(0);

    const store = new ObjectAgentHomeStore(root, storage, records);
    expect(await store.migrateLocal("bot-1")).toBe("uploaded");
    expect(await store.migrateLocal("bot-1")).toBe("stored");
  });

  it("keeps using a home's local copy until it is first saved", async () => {
    const { root, store, storage } = await setup();
    await new LocalAgentHomeStore(root).commit(
      "bot-1",
      await staged({ "a.txt": "local" }),
      context,
    );
    expect(await store.readFile("bot-1", "a.txt", context)).toBe("local");
    expect(storage.objects.size).toBe(0);
  });
});

describe("createAgentHomeStore", () => {
  it("keeps homes on local disk when object storage is not configured", async () => {
    const store = createAgentHomeStore("/tmp/unused", {} as PrismaClient, {});
    expect(store).toBeInstanceOf(LocalAgentHomeStore);
    expect(store).not.toBeInstanceOf(ObjectAgentHomeStore);
  });

  it("refuses object storage without content keys", () => {
    expect(() =>
      createAgentHomeStore("/tmp/unused", {} as PrismaClient, {
        OBJECT_STORAGE_BUCKET: "b",
        OBJECT_STORAGE_ACCESS_KEY_ID: "id",
        OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
      }),
    ).toThrow(/content encryption keys/);
  });
});
