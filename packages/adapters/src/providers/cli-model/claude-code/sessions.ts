import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bestEffort } from "@rakazo/logging";

/**
 * The CLI adds its own reminders (the date, its token budget) to the newest message of each
 * request and keeps them only in its saved session. Replaying Rakazo's transcript drops them, so
 * every step's prompt would differ from the step before and nothing past the system prompt would
 * be read from the prompt cache. Each step therefore continues the CLI's own session from where
 * the previous step left it, and sends only the reply and what came after it. The session is
 * continued from just before the reply: after a tool call the CLI saves its own refusal to run
 * it (one per call, between the calls), and none of that may stay in the conversation.
 *
 * A session lives on this machine and in this process's memory: a step that finds none here (a
 * restart, another process, an edited transcript) replays the whole transcript as a new session.
 */
export interface SavedSession {
  id: string;
  /** The CLI's id for its last entry before the reply; the reply and the rest are sent again. */
  resumeAt: string;
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

/**
 * The session whose reply is latest in this transcript, removed so only one step uses it. `held`
 * is the number of frames before that reply, which the session already holds.
 */
export function takeSession(
  hashes: string[],
  isReply: (index: number) => boolean,
): { session: SavedSession; held: number; key: string } | undefined {
  // The last frame is the one to answer, so a session's reply comes before it.
  for (let index = hashes.length - 2; index >= 0; index -= 1) {
    if (!isReply(index)) continue;
    const key = hashes[index]!;
    const session = sessions.get(key);
    if (!session) continue;
    sessions.delete(key);
    if (Date.now() - session.savedAt > SESSION_IDLE_MS) {
      forgetSessionFiles(session);
      continue;
    }
    return { session, held: index, key };
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

async function findProjectFolder(session: { id: string; configDir: string }) {
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
      // Another cleanup may have removed it since the listing.
      const info = await stat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (info && Date.now() - info.mtimeMs > STALE_FILE_MS) {
        await rm(path, { recursive: true, force: true });
      }
    }
    return folder;
  }
  return undefined;
}

type SessionPlace = Pick<SavedSession, "id" | "configDir" | "cwd">;

async function sessionFolder(session: SessionPlace): Promise<string | undefined> {
  const key = JSON.stringify([session.configDir, session.cwd]);
  const found = projectFolders.get(key) ?? (await findProjectFolder(session));
  if (found) projectFolders.set(key, found);
  return found;
}

/** The CLI's id for the entry its session saved just before this one, if the session has both. */
export async function entryBefore(session: SessionPlace, entry: string) {
  const folder = await sessionFolder(session);
  if (!folder) return undefined;
  const lines = (await readFile(join(folder, `${session.id}.jsonl`), "utf8")).split("\n");
  for (const line of lines) {
    if (!line.includes(entry)) continue;
    const saved = JSON.parse(line) as { uuid?: unknown; parentUuid?: unknown };
    if (saved.uuid === entry)
      return typeof saved.parentUuid === "string" ? saved.parentUuid : undefined;
  }
  return undefined;
}

/** Removes a session Rakazo no longer continues, so the CLI's sessions do not pile up. */
export function forgetSessionFiles(session: SessionPlace): void {
  void bestEffort(
    "Remove a finished Claude Code session",
    (async () => {
      const folder = await sessionFolder(session);
      if (!folder) return;
      await rm(join(folder, `${session.id}.jsonl`), { force: true });
      await rm(join(folder, session.id), { recursive: true, force: true });
    })(),
  );
}

/**
 * This OS user's private folder of this name, the same in every process, or else a new one of
 * this process's own (when the shared one belongs to someone else, or is not empty when it must be).
 */
function privateFolder(name: string, empty: boolean): () => string {
  let own: string | undefined;
  return () => {
    const uid = process.getuid?.();
    const folder = join(tmpdir(), `${name}-${uid ?? "user"}`);
    try {
      mkdirSync(folder, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = lstatSync(folder);
    // Windows has no owner or mode bits here; its temp folder is already the user's own.
    const mine =
      info.isDirectory() && (uid === undefined || (info.uid === uid && (info.mode & 0o077) === 0));
    if (mine && (!empty || readdirSync(folder).length === 0)) {
      return folder;
    }
    own ??= mkdtempSync(join(tmpdir(), `${name}-`));
    return own;
  };
}

/** The CLI names its working folder in the first message, so every turn uses the same empty one. */
export const workingFolder = privateFolder("rakazo-claude-code", true);

const tokenSessionsFolder = privateFolder("rakazo-claude-code-sessions", false);

/**
 * With the setup token the CLI gets a new, empty config dir for each turn, so nothing it stores
 * (such as the account's profile) reaches a later turn. Only its `projects` folder, where it saves
 * sessions, is linked to one that lasts. Returns the new config dir and that lasting folder's
 * parent, which is where Rakazo finds the sessions.
 */
export function tokenConfigFolder(parent: string): { configDir: string; sessionsDir: string } {
  const sessionsDir = tokenSessionsFolder();
  const projects = join(sessionsDir, "projects");
  mkdirSync(projects, { recursive: true, mode: 0o700 });
  const configDir = join(parent, "config");
  mkdirSync(configDir, { mode: 0o700 });
  symlinkSync(projects, join(configDir, "projects"), "junction");
  return { configDir, sessionsDir };
}

/** Where the CLI keeps its sign-in and sessions unless CLAUDE_CONFIG_DIR says otherwise. */
const CLI_HOME_FOLDER = ".claude";

/**
 * The config dir the CLI started with this environment and working folder uses. Only its
 * sessions are touched.
 */
export function cliConfigDir(childEnv: Record<string, string>, cwd: string): string {
  const home = childEnv.HOME ?? childEnv.USERPROFILE ?? "";
  return resolve(cwd, childEnv.CLAUDE_CONFIG_DIR ?? join(home, CLI_HOME_FOLDER));
}
