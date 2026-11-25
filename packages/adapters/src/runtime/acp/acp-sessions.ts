/**
 * The CLI keeps each bot's conversation in a session of its own, which this worker continues on
 * the next turn so the CLI's context and prompt cache carry over. Rakazo's stored chat stays the
 * record: a session is only a cache of it, kept in this process's memory. A turn that finds none
 * (a restart, another worker) starts a new session from the chat history.
 */
export interface AgentSession {
  id: string;
  /** The working folder the session belongs to; the CLI finds its sessions by it. */
  cwd: string;
  /** Chat history ids the session has seen. */
  seen: Set<string>;
  /** For each history message, hashes of the images the session has been sent. */
  imaged: Map<string, Set<string>>;
  /** Hashes of history entries without an id (summaries, recall) the session has seen. */
  context: Set<string>;
  /** Hashes of the replies this session wrote, told apart from replies written elsewhere. */
  replies: Set<string>;
  usedAt: number;
}

const SESSION_IDLE_MS = 7 * 24 * 60 * 60_000;
const MAX_SESSIONS = 500;

const sessions = new Map<string, AgentSession>();
/** Chats with a turn running on their session in this process. */
const busy = new Set<string>();

/** Takes a chat's session for one turn; false when another turn has it. */
export function claimSession(key: string): boolean {
  if (busy.has(key)) return false;
  busy.add(key);
  return true;
}

export function releaseSession(key: string): void {
  busy.delete(key);
}

/** Chats where a turn replied in a session of its own, which the chat's session never saw. */
const repliedElsewhere = new Set<string>();

export function noteReplyElsewhere(key: string): void {
  repliedElsewhere.delete(key);
  repliedElsewhere.add(key);
  while (repliedElsewhere.size > MAX_SESSIONS) {
    repliedElsewhere.delete(repliedElsewhere.values().next().value!);
  }
}

/** Whether the chat's session lacks replies written elsewhere, clearing the note. */
export function takeReplyElsewhere(key: string): boolean {
  return repliedElsewhere.delete(key);
}

export function sessionKey(agent: string, botId: string, threadId: string): string {
  return JSON.stringify([agent, botId, threadId]);
}

/** The session this bot's chat continues, if this process still has one. */
export function findSession(key: string, now = Date.now()): AgentSession | undefined {
  const session = sessions.get(key);
  if (!session) return undefined;
  if (now - session.usedAt > SESSION_IDLE_MS) {
    sessions.delete(key);
    return undefined;
  }
  return session;
}

export function keepSession(key: string, session: AgentSession): void {
  sessions.delete(key);
  sessions.set(key, session);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
}

export function forgetSession(key: string): void {
  sessions.delete(key);
}
