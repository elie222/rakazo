import type { Hash } from "node:crypto";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ObjectStorage,
  PortableFile,
} from "@rakazo/adapter-kit";
import type { ContentKeyRing, ContentLocation, DataKey, PrismaClient } from "@rakazo/db";
import {
  ContentDecryptionError,
  ciphertextKeyId,
  contentEncryptionOf,
  decryptText,
  encryptText,
  openArtifact,
  runAsSystem,
  sealArtifact,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { LocalAgentHomeStore, newRevision } from "./home.js";
import type { HomeArchiveLimits } from "./home-archive.js";
import {
  checkHomeArchive,
  DEFAULT_HOME_ARCHIVE_LIMITS,
  packHome,
  unpackHome,
} from "./home-archive.js";
import { objectStorageConfigFromEnv, S3ObjectStorage } from "./s3-object-storage.js";

const HOMES_PREFIX = "homes/";
const SWEEP_INTERVAL_MS = 60 * 60_000;
/** Revisions left by a crashed save are removed once they are clearly not in progress. */
const STALE_REVISION_MS = 24 * 60 * 60_000;

/** Where a home's revisions are stored and the key that seals them. */
export interface StoredHome {
  /** Random, so object keys say nothing about the bot, user or space. */
  storageId: string;
  /** The current revision, or null before the first save. */
  revision: string | null;
  key: DataKey;
}

/** The database side of stored homes: one row per home, deleted with its computer. */
export interface AgentHomeRecords {
  /** Undefined until the home is first saved, or when it has no computer. */
  load(homeKey: string): Promise<StoredHome | undefined>;
  /** Creates the storage id and data key on first save. Undefined when there is no computer. */
  create(homeKey: string): Promise<StoredHome | undefined>;
  /** Moves the current revision from `from` to `to`; false when another save got there first. */
  advance(homeKey: string, storageId: string, from: string | null, to: string): Promise<boolean>;
  /** The current revision of each storage id that still belongs to a home. */
  revisions(storageIds: readonly string[]): Promise<Map<string, string | null>>;
}

/**
 * Homes whose source of truth is object storage, with `DATA_DIR/homes` as a local cache.
 *
 * Each save packs the home into one archive, seals it with the home's data key (64 KiB
 * AES-256-GCM segments bound to the storage id and revision), and uploads it as
 * `homes/<storage id>/<revision>`. The database then moves the home to that revision and the
 * previous object is deleted. Reads first bring the cache up to the stored revision, so a cache
 * that was removed, or that another host replaced, is downloaded again.
 *
 * Docker computers keep mounting the cached directory (this extends `LocalAgentHomeStore`);
 * their checkpoints upload it. Sandboxes never see storage credentials or object URLs: files
 * still reach them only through checkout and workspace import.
 */
export class ObjectAgentHomeStore extends LocalAgentHomeStore {
  constructor(
    root: string,
    private readonly storage: ObjectStorage,
    private readonly records: AgentHomeRecords,
    private readonly limits: HomeArchiveLimits = DEFAULT_HOME_ARCHIVE_LIMITS,
  ) {
    super(root);
  }

  override describe() {
    return {
      id: "object-storage",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { revisions: false },
    };
  }

  override async checkout(botId: string, dest: string, context: AdapterContext) {
    await this.hydrate(botId);
    return super.checkout(botId, dest, context);
  }

  override async *exportHome(
    botId: string,
    context: AdapterContext,
    options?: { directory?: string; skipHidden?: boolean },
  ): AsyncGenerator<PortableFile> {
    await this.hydrate(botId);
    yield* super.exportHome(botId, context, options);
  }

  override async readFile(
    botId: string,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    await this.hydrate(botId);
    return super.readFile(botId, filePath, context, options);
  }

  override async list(botId: string, dirPath: string, context: AdapterContext) {
    await this.hydrate(botId);
    return super.list(botId, dirPath, context);
  }

  override async writeFile(
    botId: string,
    filePath: string,
    content: string,
    context: AdapterContext,
  ) {
    await this.hydrate(botId);
    await super.writeFile(botId, filePath, content, context);
    await this.revise(botId);
  }

  /**
   * Saves the cached copy, which a Docker computer has been changing in place. Refused when
   * the cache is missing or older than the stored revision, so a stale or empty copy never
   * replaces a newer one, even if another host saves while this one packs.
   */
  override async revise(botId: string): Promise<string> {
    return this.withBotWrite(botId, async () => {
      const [stored, local] = await Promise.all([
        this.records.load(botId),
        this.localRevision(botId),
      ]);
      const base = stored?.revision ?? null;
      if (base && (local !== base || !(await this.hasCache(botId))))
        throw new Error("The cached home is older than its stored revision");
      return (await this.upload(botId, { base })).revision;
    });
  }

  /** Called by `commit` with the bot's write lock held; the staged copy is authoritative. */
  protected override async writeRevision(botId: string): Promise<string> {
    return (await this.upload(botId)).revision;
  }

  /**
   * Brings the cached copy up to the stored revision. A home never saved to object storage
   * keeps its local copy, so homes from before object storage keep working until they are
   * migrated or next saved.
   */
  async hydrate(botId: string): Promise<void> {
    await this.withBotWrite(botId, async () => {
      const stored = await this.records.load(botId);
      if (!stored?.revision) return;
      // A removed cache directory leaves its marker behind; only a present copy counts.
      if ((await this.localRevision(botId)) === stored.revision && (await this.hasCache(botId)))
        return;
      const revision = stored.revision;
      await this.replaceHome(botId, (staging) =>
        unpackHome(this.download(stored, revision), staging, this.limits),
      );
      await super.writeRevision(botId, revision);
    });
  }

  private async hasCache(botId: string) {
    await this.recoverInterruptedCommit(botId);
    return stat(this.pathFor(botId)).then(
      (info) => info.isDirectory(),
      () => false,
    );
  }

  /**
   * Packs, seals and uploads the cached copy, then moves the home to it. `base` is the stored
   * revision the copy was checked against (default: whatever is stored now); the move fails if
   * the home has moved past it. With `verify`, the object is downloaded and checked before the
   * home points at it.
   */
  private async upload(
    botId: string,
    options: { base?: string | null; verify?: boolean } = {},
  ): Promise<{ revision: string }> {
    const stored = await this.records.create(botId);
    if (!stored) throw new Error("Agent home has no computer");
    const base = options.base === undefined ? stored.revision : options.base;
    const revision = newRevision();
    const key = objectKey(stored.storageId, revision);
    const digest = createHash("sha256");
    const home = this.pathFor(botId);
    await mkdir(home, { recursive: true });
    await this.storage.put(
      key,
      sealArtifact(
        stored.key,
        sealedId(stored.storageId, revision),
        tap(packHome(home, this.limits), digest),
      ),
    );
    const discard = () => this.storage.delete([key]).catch(() => undefined);
    if (options.verify)
      await this.verify(stored, revision, digest.digest("hex")).catch(async (error) => {
        await discard();
        throw error;
      });
    // Only a confirmed refusal discards the upload. An error may hide a committed update, so
    // that object is left for the sweep, which keeps whatever revision the home points at.
    if (!(await this.records.advance(botId, stored.storageId, base, revision))) {
      await discard();
      throw new Error("Agent home was saved elsewhere at the same time");
    }
    await super.writeRevision(botId, revision);
    if (base)
      await this.storage
        .delete([objectKey(stored.storageId, base)])
        .catch((error) => getLogger().error("previous home revision removal failed", error));
    return { revision };
  }

  /** Decrypted archive bytes of one revision; any tampering fails authentication. */
  private download(stored: StoredHome, revision: string): AsyncIterable<Uint8Array> {
    return openArtifact(
      async (keyId) => {
        if (keyId !== stored.key.id)
          throw new ContentDecryptionError("Stored home belongs to another home");
        return stored.key;
      },
      sealedId(stored.storageId, revision),
      this.storage.get(objectKey(stored.storageId, revision)),
    );
  }

  /**
   * Deletes objects whose home no longer exists (its computer, bot, space or account was
   * deleted, which also deleted its key) and revisions a crashed save left behind. Assumes the
   * bucket prefix belongs to this deployment alone; deletes nothing when the database knows
   * none of the stored homes.
   */
  async sweep(now = Date.now()): Promise<number> {
    const found = new Map<string, Array<{ key: string; revision: string; lastModified: Date }>>();
    for await (const object of this.storage.list(HOMES_PREFIX)) {
      const [storageId, revision, extra] = object.key.slice(HOMES_PREFIX.length).split("/");
      if (!storageId || !revision || extra !== undefined) continue;
      found.set(storageId, [...(found.get(storageId) ?? []), { ...object, revision }]);
    }
    const current = await this.records.revisions([...found.keys()]);
    // A database that knows none of the stored homes is more likely the wrong database (or
    // one this process cannot read) than one whose every home was deleted.
    if (found.size > 0 && current.size === 0) {
      getLogger().warn("home.storage.sweep_skipped", { "home.objects.unknown": found.size });
      return 0;
    }
    const doomed = [...found].flatMap(([storageId, objects]) =>
      objects
        .filter(
          (object) =>
            !current.has(storageId) ||
            (object.revision !== current.get(storageId) &&
              now - object.lastModified.getTime() > STALE_REVISION_MS),
        )
        .map((object) => object.key),
    );
    await this.storage.delete(doomed);
    return doomed.length;
  }

  /** Home keys with a directory in the local cache, for migration. */
  async localHomes(): Promise<string[]> {
    const entries = await readdir(path.join(this.root, "homes"), { withFileTypes: true }).catch(
      () => [],
    );
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.endsWith(".previous"),
      )
      .map((entry) => entry.name)
      .sort();
  }

  /**
   * Uploads a home that exists only on local disk, downloads it again and checks it decrypts to
   * the same archive, and only then records it as stored. Homes already stored were verified
   * this way (or saved by a running computer), so a rerun after an interruption skips them.
   * Local files are never deleted.
   */
  async migrateLocal(
    botId: string,
    { dryRun = false }: { dryRun?: boolean } = {},
  ): Promise<"uploaded" | "would-upload" | "stored" | "no-computer"> {
    return this.withBotWrite(botId, async () => {
      if ((await this.records.load(botId))?.revision) return "stored";
      if (dryRun) return "would-upload";
      if (!(await this.records.create(botId))) return "no-computer";
      await this.upload(botId, { base: null, verify: true });
      return "uploaded";
    });
  }

  private async verify(stored: StoredHome, revision: string, expected: string) {
    const digest = createHash("sha256");
    await checkHomeArchive(tap(this.download(stored, revision), digest), this.limits);
    if (digest.digest("hex") !== expected)
      throw new Error("Stored home does not match what was uploaded");
  }
}

/** Data keys live on the home's computer row, wrapped by the space's content key. */
export class PrismaAgentHomeRecords implements AgentHomeRecords {
  constructor(
    private readonly prisma: Pick<PrismaClient, "computer">,
    private readonly ring: Pick<ContentKeyRing, "current" | "byId">,
  ) {}

  // The caller already decided who may use this home; the row only says where it is stored.
  private row(homeKey: string) {
    return runAsSystem("resolve where an agent home is stored", () =>
      this.prisma.computer.findUnique({
        where: { homeKey },
        select: {
          id: true,
          spaceId: true,
          homeStorageId: true,
          homeStorageKey: true,
          homeStorageRevision: true,
        },
      }),
    );
  }

  async load(homeKey: string): Promise<StoredHome | undefined> {
    const row = await this.row(homeKey);
    if (!row?.homeStorageId || !row.homeStorageKey) return undefined;
    return {
      storageId: row.homeStorageId,
      revision: row.homeStorageRevision,
      key: await this.unwrap({
        ...row,
        homeStorageId: row.homeStorageId,
        homeStorageKey: row.homeStorageKey,
      }),
    };
  }

  async create(homeKey: string): Promise<StoredHome | undefined> {
    const row = await this.row(homeKey);
    if (!row) return undefined;
    if (!row.homeStorageId) {
      const storageId = randomBytes(16).toString("hex");
      const wrapped = encryptText(
        await this.ring.current(row.spaceId),
        keyLocation(row.id, storageId),
        randomBytes(32).toString("base64"),
      );
      // Two first saves can race; the loser uses the winner's key.
      await runAsSystem("create an agent home's storage key", () =>
        this.prisma.computer.updateMany({
          where: { id: row.id, homeStorageId: null },
          data: { homeStorageId: storageId, homeStorageKey: wrapped, homeStorageRevision: null },
        }),
      );
    }
    return this.load(homeKey);
  }

  async advance(homeKey: string, storageId: string, from: string | null, to: string) {
    const { count } = await runAsSystem("record an agent home's saved revision", () =>
      this.prisma.computer.updateMany({
        where: { homeKey, homeStorageId: storageId, homeStorageRevision: from },
        data: { homeStorageRevision: to },
      }),
    );
    return count === 1;
  }

  async revisions(storageIds: readonly string[]) {
    const current = new Map<string, string | null>();
    for (let start = 0; start < storageIds.length; start += 1000) {
      const rows = await runAsSystem("find which stored agent homes still exist", () =>
        this.prisma.computer.findMany({
          where: { homeStorageId: { in: storageIds.slice(start, start + 1000) } },
          select: { homeStorageId: true, homeStorageRevision: true },
        }),
      );
      for (const row of rows)
        if (row.homeStorageId) current.set(row.homeStorageId, row.homeStorageRevision);
    }
    return current;
  }

  /** A wrapped key copied to another computer row, or another space, fails to unwrap. */
  private async unwrap(row: {
    id: string;
    spaceId: string;
    homeStorageId: string;
    homeStorageKey: string;
  }): Promise<DataKey> {
    const spaceKeyId = ciphertextKeyId(row.homeStorageKey);
    if (!spaceKeyId) throw new ContentDecryptionError("Stored home key is malformed");
    const spaceKey = await this.ring.byId(spaceKeyId);
    if (spaceKey.spaceId !== row.spaceId)
      throw new ContentDecryptionError("Stored home key belongs to another space");
    const key = Buffer.from(
      decryptText(spaceKey, keyLocation(row.id, row.homeStorageId), row.homeStorageKey),
      "base64",
    );
    if (key.length !== 32) throw new ContentDecryptionError("Stored home key is malformed");
    return { id: row.homeStorageId, spaceId: row.spaceId, version: 1, key };
  }
}

/**
 * The home store for this deployment: object storage when `OBJECT_STORAGE_BUCKET` is set,
 * otherwise homes stay on local disk under `DATA_DIR`, exactly as before.
 */
export function createAgentHomeStore(
  dataDir: string,
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): LocalAgentHomeStore {
  const config = objectStorageConfigFromEnv(env);
  if (!config) return new LocalAgentHomeStore(dataDir);
  const ring = contentEncryptionOf(prisma)?.ring;
  if (!ring) throw new Error("Storing homes in object storage needs content encryption keys");
  return new ObjectAgentHomeStore(
    dataDir,
    new S3ObjectStorage(config),
    new PrismaAgentHomeRecords(prisma, ring),
  );
}

/** Hourly object cleanup for the worker's reconciler, when homes are in object storage. */
export function homeStorageSweeper(home: AgentHomeStore): (() => Promise<void>) | undefined {
  if (!(home instanceof ObjectAgentHomeStore)) return undefined;
  let lastRun: number | undefined;
  return async () => {
    const now = Date.now();
    if (lastRun !== undefined && now - lastRun < SWEEP_INTERVAL_MS) return;
    lastRun = now;
    const removed = await home.sweep(now);
    if (removed) getLogger().info("home.storage.swept", { "home.objects.removed": removed });
  };
}

function objectKey(storageId: string, revision: string) {
  return `${HOMES_PREFIX}${storageId}/${revision}`;
}

/** Bound into every sealed segment, so an object moved to another home or revision fails. */
function sealedId(storageId: string, revision: string) {
  return `home/${storageId}/${revision}`;
}

function keyLocation(computerId: string, storageId: string): ContentLocation {
  return { table: "computers", column: "homeStorageKey", rowId: computerId, owner: storageId };
}

async function* tap<T extends Uint8Array>(source: AsyncIterable<T>, hash: Hash): AsyncGenerator<T> {
  for await (const chunk of source) {
    hash.update(chunk);
    yield chunk;
  }
}
