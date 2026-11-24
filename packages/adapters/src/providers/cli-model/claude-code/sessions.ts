import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bestEffort } from "@rakazo/logging";

/**
 * The CLI adds its own reminders (the date, its token budget) to the newest message of each
 * request and keeps them only in its saved session. Replaying Rakazo's transcript drops them, so
 * every step's prompt would differ from the step before and nothing past the system prompt would
 * be read from the prompt cache. Each step therefore continues the CLI's own session from where
 * the previous step left it, and sends only what is new.
 *
 * A session lives on this machine and in this process's memory: a step that finds none here (a
 * restart, another process, an edited transcript) replays the whole transcript as a new session.
 */
export interface SavedSession {
  id: string;
  /** The CLI's id for the reply the session ends with; anything the CLI added after it is dropped. */
  replyId: string;
  /** The CLI's config dir and working folder, which decide where its session files live. */
  configDir: string;
  cwd: string;
  savedAt: number;
}

/** Kept a little past the prompt cache's longest lifetime, after which a resume saves nothing. */
const SESSION_IDLE_MS = 70 * 60_000;
const MAX_SESSIONS = 100;
/** Session files older than this in Rakazo's project folder were left by an earlier process. */
const STALE_FILE_MS = 24 * 60 * 60_000;

/** Keyed by a hash of the transcript each session holds. */
const sessions = new Map<string, SavedSession>();

/** A running hash of the frames a session holds, starting from what the prompt is built from. */
export function transcriptHashes(seed: unknown, messages: unknown[]): string[] {
  let hash = createHash("sha256").update(JSON.stringify(seed)).digest("hex");
  return messages.map((message) => {
    hash = createHash("sha256").update(hash).update(JSON.stringify(message)).digest("hex");
    return hash;
  });
}

/** The session holding the longest prefix of this transcript, removed so only one step uses it. */
export function takeSession(
  hashes: string[],
  isReply: (index: number) => boolean,
): { session: SavedSession; held: number } | undefined {
  // The last frame is the one to answer, so a session must end before it.
  for (let index = hashes.length - 2; index >= 0; index -= 1) {
    if (!isReply(index)) continue;
    const session = sessions.get(hashes[index]!);
    if (!session) continue;
    sessions.delete(hashes[index]!);
    if (Date.now() - session.savedAt > SESSION_IDLE_MS) {
      forgetSessionFiles(session);
      return undefined;
    }
    return { session, held: index + 1 };
  }
  return undefined;
}

export function saveSession(hash: string, session: SavedSession): void {
  const replaced = sessions.get(hash);
  if (replaced && replaced.id !== session.id) forgetSessionFiles(replaced);
  sessions.delete(hash);
  sessions.set(hash, session);
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (sessions.size <= MAX_SESSIONS && now - entry.savedAt <= SESSION_IDLE_MS) break;
    sessions.delete(key);
    forgetSessionFiles(entry);
  }
}

/** The CLI keeps a session's transcript in `<config dir>/projects/<folder named for its cwd>/`. */
const projectFolders = new Map<string, string>();

async function findProjectFolder(session: SavedSession): Promise<string | undefined> {
  const projects = join(session.configDir, "projects");
  const entries = await readdir(projects, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = join(projects, entry.name);
    const found = await stat(join(folder, `${session.id}.jsonl`)).then(
      () => true,
      () => false,
    );
    if (!found) continue;
    // The folder belongs to Rakazo's own working folder, so anything old in it is a leftover.
    for (const file of await readdir(folder)) {
      const path = join(folder, file);
      const { mtimeMs } = await stat(path);
      if (Date.now() - mtimeMs > STALE_FILE_MS) await rm(path, { recursive: true, force: true });
    }
    return folder;
  }
  return undefined;
}

/** Removes a session Rakazo no longer continues, so the CLI's sessions do not pile up. */
export function forgetSessionFiles(session: SavedSession): void {
  void bestEffort(
    "Remove a finished Claude Code session",
    (async () => {
      const key = JSON.stringify([session.configDir, session.cwd]);
      const found = projectFolders.get(key) ?? (await findProjectFolder(session));
      if (!found) return;
      projectFolders.set(key, found);
      await rm(join(found, `${session.id}.jsonl`), { force: true });
      await rm(join(found, session.id), { recursive: true, force: true });
    })(),
  );
}

/** One private folder per process, created on first use. */
function processFolder(prefix: string): () => string {
  let folder: string | undefined;
  return () => {
    folder ??= mkdtempSync(join(tmpdir(), prefix));
    return folder;
  };
}

const ownCwd = processFolder("rakazo-claude-code-cwd-");

/**
 * The CLI names its working folder in the first message, so every turn and every process uses
 * the same empty one. If that folder is not this user's private, empty folder, this process
 * makes its own.
 */
export async function workingFolder(): Promise<string> {
  const uid = process.getuid?.();
  const folder = join(tmpdir(), `rakazo-claude-code-${uid ?? "cwd"}`);
  try {
    await mkdir(folder, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(folder);
  const own = info.isDirectory() && (uid === undefined || info.uid === uid);
  if (own && (info.mode & 0o077) === 0 && (await readdir(folder)).length === 0) return folder;
  return ownCwd();
}

/** With the setup token the CLI gets an empty config dir of its own, which also holds its sessions. */
export const tokenConfigFolder = processFolder("rakazo-claude-code-config-");

/** Where the CLI keeps its sign-in and sessions unless CLAUDE_CONFIG_DIR says otherwise. */
const CLI_HOME_FOLDER = ".claude";

/** The config dir the CLI started with this environment uses. Only its sessions are touched. */
export function cliConfigDir(env: Record<string, string>): string {
  return env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? env.USERPROFILE ?? "", CLI_HOME_FOLDER);
}
