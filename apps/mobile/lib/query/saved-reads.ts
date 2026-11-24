import type { RpcPath } from "@rakazo/contracts";
import { appContract } from "@rakazo/contracts";
import { displayIdentityResult, identitySource } from "@rakazo/core";
import { identityLabels } from "@rakazo/i18n/identity-display";
import { bestEffort } from "@rakazo/logging/best-effort";
import type { Query, QueryClient } from "@tanstack/react-query";
import { Directory, File, Paths } from "expo-file-system";
import { z } from "zod";
import { currentApiBase } from "../api/api";
import type { SavedVerifiedScope } from "../api/session";
import { currentSessionGeneration, loadVerifiedScope } from "../api/session";
import { verifiedScope, verifiedSpaceId } from "../api/verified-scope";
import { cacheFolder } from "../platform/cache-folder";

/** Where an rpc read was sent, carried in its query's meta. */
export type RpcReadMeta = {
  proc: RpcPath;
  input: unknown;
  apiBase: string;
  sessionGeneration: number;
  /** Null for the account's own data, which is the same in every Space. */
  space: { id: string | null } | null;
};

/**
 * The reads whose last answer is kept on disk, so a cold launch paints it before the network
 * answers, whichever screen reads them. Only answers that hold no secrets (tokens, credentials,
 * sealed values, or addresses and settings people type in, which can carry keys) belong here, and
 * only answers no write is built from unless the server checks it again: consent (sent back by
 * version) and `me` (Labs sends its whole list back) stay in memory.
 */
const SAVED_PROCEDURES: ReadonlySet<RpcPath> = new Set<RpcPath>([
  // Integrations
  "connections/catalog",
  "connections/list",
  "capabilities/sourcePresets",
  "marketplace/catalog",
]);

const ROOT = "saved-reads-v1";
/** The Integrations screen kept its own copy here before every settings read could. */
const LEGACY_ROOT = "integrations-v1";
export const SAVED_READ_MAX_BYTES = 2 * 1024 * 1024;
export const SAVED_READS_MAX_BYTES = 10 * 1024 * 1024;
const MAX_NAME = 200;
const folder = cacheFolder(ROOT);
/** Each file's answer as last written or read, so an unchanged answer is not written again. */
const onDisk = new Map<string, string>();
/** What a saved file holds around the answer; anything else is a cold miss. */
const SavedFileSchema = z.object({ key: z.string(), savedAt: z.number(), data: z.unknown() });
/** The latest save each read started: an older one that finishes later is dropped. */
const latestSave = new Map<string, number>();
let saves = 0;
/** Reads already painted from disk, or tried: each read is seeded once. */
const seeded = new WeakSet<Query>();
/** Seeds in flight. A reset or invalidation of the read meanwhile drops its seed. */
const seeding = new Map<Query, number>();
let seeds = 0;

type Checked = { value?: unknown; issues?: unknown };
type Schema = {
  "~standard": {
    validate: (value: unknown) => Checked | Promise<Checked>;
  };
};

/** The procedure's output schema in the shared contract, which a saved answer must still match. */
function outputSchema(proc: RpcPath): Schema | undefined {
  let node: unknown = appContract;
  for (const part of proc.split("/")) node = (node as Record<string, unknown> | undefined)?.[part];
  return (node as { "~orpc"?: { outputSchema?: Schema } } | undefined)?.["~orpc"]?.outputSchema;
}

function readMeta(query: Query): RpcReadMeta | null {
  const meta = query.meta?.rpc as RpcReadMeta | undefined;
  return meta && SAVED_PROCEDURES.has(meta.proc) ? meta : null;
}

/** The read's scope is still the one shown: same server and session. */
function isCurrent(meta: RpcReadMeta): boolean {
  return meta.apiBase === currentApiBase() && meta.sessionGeneration === currentSessionGeneration();
}

/**
 * The file a read's answer is kept in: server, verified user, and Space or account, never the
 * session generation, which starts again at every launch.
 */
function savedFile(meta: RpcReadMeta, user: Pick<SavedVerifiedScope, "userId">, spaceId?: string) {
  const input = meta.input ?? {};
  const name = `${encodeURIComponent(JSON.stringify([meta.proc, input]))}.json`;
  if (name.length > MAX_NAME) return null;
  const key = JSON.stringify([meta.apiBase, user.userId, spaceId ?? null, meta.proc, input]);
  const directory = new Directory(
    folder.root,
    encodeURIComponent(meta.apiBase),
    `user-${encodeURIComponent(user.userId)}`,
    spaceId === undefined ? "account" : `space-${encodeURIComponent(spaceId)}`,
  );
  return { directory, file: new File(directory, name), key };
}

/** The Space a read went to, resolved through a verified identity; undefined when it cannot be. */
function resolvedSpace(meta: RpcReadMeta, user: SavedVerifiedScope): string | null | undefined {
  return meta.space ? verifiedSpaceId(meta.space.id, user) : undefined;
}

async function verifiedUser(meta: RpcReadMeta, ask: boolean): Promise<SavedVerifiedScope | null> {
  const saved = await loadVerifiedScope();
  if (saved?.apiBase === meta.apiBase) return saved;
  return ask ? verifiedScope() : null;
}

/** Paints a saved answer into a read that has none yet; the read's own fetch still replaces it. */
async function seed(query: Query, meta: RpcReadMeta): Promise<void> {
  const started = ++seeds;
  seeding.set(query, started);
  try {
    await paint(query, meta, () => seeding.get(query) === started);
  } finally {
    if (seeding.get(query) === started) seeding.delete(query);
  }
}

async function paint(query: Query, meta: RpcReadMeta, undisturbed: () => boolean) {
  const schema = outputSchema(meta.proc);
  const user = schema && (await verifiedUser(meta, false));
  if (!schema || !user || query.state.data !== undefined || !isCurrent(meta)) return;
  const space = resolvedSpace(meta, user);
  if (space === null) return;
  clearLegacy();
  const target = savedFile(meta, user, space);
  if (!target?.file.exists || target.file.size > SAVED_READ_MAX_BYTES) return;
  const envelope = SavedFileSchema.safeParse(JSON.parse(target.file.textSync()));
  if (!envelope.success || envelope.data.key !== target.key) return;
  const saved = envelope.data;
  // An answer saved by an older app, or from a server that changed, is a cold miss.
  const checked = await schema["~standard"].validate(saved.data);
  if (checked.issues) return;
  // The fetch that opened the read may have answered while the file was read.
  if (query.state.data !== undefined || !isCurrent(meta) || !undisturbed()) return;
  onDisk.set(target.file.uri, JSON.stringify(saved.data));
  query.setState({
    data: displayIdentityResult(meta.proc.split("/"), checked.value, identityLabels()),
    dataUpdatedAt: saved.savedAt,
    // A saved answer is only shown until the network answers, never trusted as fresh.
    isInvalidated: true,
    ...(query.state.status === "pending" && { status: "success" as const }),
  });
}

async function save(query: Query, meta: RpcReadMeta, data: unknown): Promise<void> {
  if (!outputSchema(meta.proc)) return;
  const started = ++saves;
  latestSave.set(query.queryHash, started);
  const user = await verifiedUser(meta, true);
  if (!user || !isCurrent(meta)) return;
  const space = resolvedSpace(meta, user);
  if (space === null) return;
  const target = savedFile(meta, user, space);
  if (!target) return;
  const answer = JSON.stringify(identitySource(data));
  if (onDisk.get(target.file.uri) === answer && target.file.exists) return;
  const text = `{"key":${JSON.stringify(target.key)},"savedAt":${Date.now()},"data":${answer}}`;
  if (new TextEncoder().encode(text).length > SAVED_READ_MAX_BYTES) return;
  clearLegacy();
  if (!isCurrent(meta) || latestSave.get(query.queryHash) !== started) return;
  if (!target.directory.exists) target.directory.create({ intermediates: true, idempotent: true });
  // The reads seen longest ago make room for this one.
  folder.write(target.file, text, { totalBytes: SAVED_READS_MAX_BYTES });
  onDisk.set(target.file.uri, answer);
}

/**
 * Keeps the answers of the reads in `SAVED_PROCEDURES` on disk and paints them into a fresh
 * client. Only answers are saved: what shows from disk is refreshed at once and never decides
 * access, and a read nothing shows (a disabled one) is not painted.
 */
export function keepSavedReads(client: QueryClient): void {
  client.getQueryCache().subscribe((event) => {
    const meta = readMeta(event.query);
    if (!meta) return;
    // A screen that opens on a read with nothing in memory, or turns a read on (enabled), paints
    // the saved answer meanwhile.
    if (
      (event.type === "observerAdded" || event.type === "observerOptionsUpdated") &&
      event.query.state.data === undefined &&
      event.query.isActive() &&
      !seeded.has(event.query)
    ) {
      seeded.add(event.query);
      void bestEffort("show a saved read", seed(event.query, meta));
    } else if (event.type === "updated" && event.action.type === "success")
      void bestEffort("save a read", save(event.query, meta, event.action.data));
    // A reset or invalidation (consent granted, a change elsewhere) outdates a saved answer.
    else if (
      event.type === "updated" &&
      (event.action.type === "setState" || event.action.type === "invalidate")
    )
      seeding.delete(event.query);
  });
}

/** Forgets every saved read; the session registers this so sign-out leaves none behind. */
export function clearSavedReads(): void {
  clearLegacy();
  onDisk.clear();
  latestSave.clear();
  folder.clear();
}

function clearLegacy(): void {
  const legacy = new Directory(Paths.cache, LEGACY_ROOT);
  if (legacy.exists) legacy.delete();
}
