import type { RpcPath } from "@rakazo/contracts";
import { appContract } from "@rakazo/contracts";
import { displayIdentityResult, identitySource } from "@rakazo/core";
import { identityLabels } from "@rakazo/i18n/identity-display";
import { bestEffort } from "@rakazo/logging/best-effort";
import type { Query, QueryClient } from "@tanstack/react-query";
import { Directory, File, Paths } from "expo-file-system";
import { currentApiBase } from "../api/api";
import type { SavedVerifiedScope } from "../api/session";
import { currentSessionGeneration, loadVerifiedScope } from "../api/session";
import { verifiedScope } from "../api/verified-scope";

/**
 * Where an rpc read was sent, carried in its query's meta. `persist` is set only by `persisted`:
 * those reads also keep their last answer on disk, so a cold launch paints it at once.
 */
export type RpcReadMeta = {
  proc: RpcPath;
  input: unknown;
  apiBase: string;
  sessionGeneration: number;
  /** Null for the account's own data, which is the same in every Space. */
  space: { id: string | null } | null;
  persist?: true;
};

const ROOT = "saved-reads-v1";
/** The Integrations screen kept its own copy here before every settings read could. */
const LEGACY_ROOT = "integrations-v1";
export const SAVED_READ_MAX_BYTES = 2 * 1024 * 1024;
export const SAVED_READS_MAX_BYTES = 10 * 1024 * 1024;
const MAX_NAME = 200;

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
  return meta?.persist ? meta : null;
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
    Paths.cache,
    ROOT,
    encodeURIComponent(meta.apiBase),
    `user-${encodeURIComponent(user.userId)}`,
    spaceId === undefined ? "account" : `space-${encodeURIComponent(spaceId)}`,
  );
  return { directory, file: new File(directory, name), key };
}

/** The Space a read went to, resolved through a verified identity; undefined when it cannot be. */
function resolvedSpace(meta: RpcReadMeta, user: SavedVerifiedScope): string | null | undefined {
  if (!meta.space) return undefined;
  if (meta.space.id) return meta.space.id;
  // No Space selected: the verified identity names the one the server chose, when it saw the same.
  return user.selectionId === null ? user.spaceId : null;
}

async function verifiedUser(meta: RpcReadMeta, ask: boolean): Promise<SavedVerifiedScope | null> {
  const saved = await loadVerifiedScope();
  if (saved?.apiBase === meta.apiBase) return saved;
  return ask ? verifiedScope() : null;
}

/** Paints a saved answer into a read that has none yet; the read's own fetch still replaces it. */
async function seed(query: Query, meta: RpcReadMeta): Promise<void> {
  const schema = outputSchema(meta.proc);
  const user = schema && (await verifiedUser(meta, false));
  if (!schema || !user || query.state.data !== undefined || !isCurrent(meta)) return;
  const space = resolvedSpace(meta, user);
  if (space === null) return;
  clearLegacy();
  const target = savedFile(meta, user, space);
  if (!target?.file.exists || target.file.size > SAVED_READ_MAX_BYTES) return;
  const saved = JSON.parse(target.file.textSync()) as {
    key?: unknown;
    savedAt?: unknown;
    data?: unknown;
  };
  if (saved?.key !== target.key || typeof saved.savedAt !== "number") return;
  // An answer saved by an older app, or from a server that changed, is a cold miss.
  const checked = await schema["~standard"].validate(saved.data);
  if (checked.issues) return;
  // The fetch that opened the read may have answered while the file was read.
  if (query.state.data !== undefined || !isCurrent(meta)) return;
  query.setState({
    data: displayIdentityResult(meta.proc.split("/"), checked.value, identityLabels()),
    dataUpdatedAt: saved.savedAt,
    // A saved answer is only shown until the network answers, never trusted as fresh.
    isInvalidated: true,
    ...(query.state.status === "pending" && { status: "success" as const }),
  });
}

async function save(meta: RpcReadMeta, data: unknown): Promise<void> {
  if (!outputSchema(meta.proc)) return;
  const user = await verifiedUser(meta, true);
  if (!user || !isCurrent(meta)) return;
  const space = resolvedSpace(meta, user);
  if (space === null) return;
  const target = savedFile(meta, user, space);
  if (!target) return;
  const text = JSON.stringify({ key: target.key, savedAt: Date.now(), data: identitySource(data) });
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > SAVED_READ_MAX_BYTES) return;
  clearLegacy();
  // Oldest first, so the reads seen longest ago make room for this one.
  const others: File[] = [];
  const collect = (directory: Directory) => {
    for (const entry of directory.list()) {
      if (entry instanceof File) {
        if (entry.uri !== target.file.uri) others.push(entry);
      } else collect(entry);
    }
  };
  const root = new Directory(Paths.cache, ROOT);
  if (root.exists) collect(root);
  others.sort((a, b) => (a.lastModified ?? 0) - (b.lastModified ?? 0));
  let total = bytes + others.reduce((sum, file) => sum + file.size, 0);
  for (const oldest of others) {
    if (total <= SAVED_READS_MAX_BYTES) break;
    total -= oldest.size;
    oldest.delete();
  }
  if (!isCurrent(meta)) return;
  if (!target.directory.exists) target.directory.create({ intermediates: true, idempotent: true });
  target.file.create({ overwrite: true });
  target.file.writeSync(text);
}

/**
 * Keeps the answers of the reads marked `persisted` on disk and paints them into a fresh client.
 * Only answers are saved: what shows from disk is refreshed at once and never decides access.
 */
export function keepSavedReads(client: QueryClient): void {
  client.getQueryCache().subscribe((event) => {
    const meta = readMeta(event.query);
    if (!meta) return;
    // A screen that opens on a read with nothing in memory paints the saved answer meanwhile.
    if (event.type === "observerAdded" && event.query.state.data === undefined)
      void bestEffort("show a saved read", seed(event.query, meta));
    else if (event.type === "updated" && event.action.type === "success")
      void bestEffort("save a read", save(meta, event.action.data));
  });
}

/** Forgets every saved read; the session registers this so sign-out leaves none behind. */
export function clearSavedReads(): void {
  clearLegacy();
  const root = new Directory(Paths.cache, ROOT);
  if (root.exists) root.delete();
}

function clearLegacy(): void {
  const legacy = new Directory(Paths.cache, LEGACY_ROOT);
  if (legacy.exists) legacy.delete();
}
