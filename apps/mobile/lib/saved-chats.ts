import { Directory, File, Paths } from "expo-file-system";
import type {
  MobileBot,
  MobileBotSection,
  MobileGroup,
  MobileMe,
  MobileSnapshot,
  MobileSpace,
  MobileSpaceNavigation,
} from "./api";
import { currentApiBase, selectedSpaceId } from "./api";
import { artifactCacheSession } from "./artifact-cache-session";
import type { IntegrationsCacheScope } from "./integrations-cache";
import { integrationsCacheScope, isIntegrationsScopeCurrent } from "./integrations-cache";
import {
  currentSessionGeneration,
  loadSessionToken,
  loadVerifiedIntegrationsScope,
  saveVerifiedIntegrationsScope,
} from "./session";

export type SavedChatsScope = IntegrationsCacheScope & { namespace: string };

export type SavedInbox = {
  bots: MobileBot[];
  groups: MobileGroup[];
  botSections: MobileBotSection[];
  spaces: MobileSpace[];
  me: Pick<MobileMe, "userId" | "spaceId" | "name">;
};

export const SAVED_CHAT_MESSAGES = 100;
export const SAVED_CHATS = 40;
export const SAVED_INBOXES = 10;
const ROOT = "saved-chats-v1";
export const SAVED_CHAT_MAX_BYTES = 1024 * 1024;
export const SAVED_CHATS_MAX_BYTES = 20 * 1024 * 1024;
const SAVED_INBOX_ROWS = 200;

export function savedChatTarget(target: { botId?: string; groupId?: string }): string {
  return target.groupId ? `group:${target.groupId}` : `bot:${target.botId}`;
}

function spaceFile(scope: SavedChatsScope, name: string): File {
  const root = new Directory(
    Paths.cache,
    ROOT,
    scope.namespace,
    encodeURIComponent(scope.apiBase),
    `user-${encodeURIComponent(scope.userId)}`,
    `space-${encodeURIComponent(scope.spaceId)}`,
  );
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  return new File(root, `${encodeURIComponent(name)}.json`);
}

function scopeKey(scope: SavedChatsScope, name: string): string {
  return JSON.stringify([scope.namespace, scope.apiBase, scope.userId, scope.spaceId, name]);
}

function readJson(file: File, key: string): Record<string, unknown> | null {
  if (!file.exists || file.size > SAVED_CHAT_MAX_BYTES) return null;
  const data = JSON.parse(file.textSync());
  return data && typeof data === "object" && data.key === key ? data : null;
}

function isRows(value: unknown): value is Array<{ id: string }> {
  return (
    Array.isArray(value) &&
    value.every((row) => row && typeof row === "object" && typeof row.id === "string")
  );
}

export function readSavedInbox(scope: SavedChatsScope): SavedInbox | null {
  if (!isIntegrationsScopeCurrent(scope)) return null;
  try {
    const data = readJson(spaceFile(scope, "inbox"), scopeKey(scope, "inbox"));
    const inbox = data?.inbox as SavedInbox | undefined;
    const me = inbox?.me;
    if (
      !inbox ||
      !isRows(inbox.bots) ||
      !isRows(inbox.groups) ||
      !isRows(inbox.botSections) ||
      !isRows(inbox.spaces) ||
      me?.userId !== scope.userId ||
      typeof me.spaceId !== "string" ||
      typeof me.name !== "string"
    )
      return null;
    return inbox;
  } catch {
    return null;
  }
}

export function writeSavedInbox(
  scope: SavedChatsScope,
  navigation: MobileSpaceNavigation,
  me: MobileMe,
): void {
  try {
    const inbox: SavedInbox = {
      bots: navigation.current.bots.slice(0, SAVED_INBOX_ROWS).map(
        ({
          id,
          name,
          title,
          color,
          preview,
          unread,
          pinned,
          spaceId,
          status,
          sectionId,
          parentBotId,
          notifyOnFinish,
          threadId,
          updatedAt,
        }) =>
          ({
            id,
            name,
            title,
            color,
            preview,
            unread,
            pinned,
            spaceId,
            status,
            sectionId,
            parentBotId,
            notifyOnFinish,
            threadId,
            updatedAt,
          }) as MobileBot,
      ),
      groups: navigation.current.groups.slice(0, SAVED_INBOX_ROWS).map(
        ({ id, name, members, preview, unread, pinned, spaceId, sectionId, updatedAt }) =>
          ({
            id,
            name,
            members,
            sectionId,
            preview,
            unread,
            pinned,
            spaceId,
            updatedAt,
          }) as MobileGroup,
      ),
      botSections: navigation.current.botSections.slice(0, SAVED_INBOX_ROWS),
      spaces: navigation.spaces.slice(0, 40).map((space) => ({
        ...space,
        bots: space.bots.slice(0, SAVED_INBOX_ROWS),
        groups: space.groups.slice(0, SAVED_INBOX_ROWS),
        externalConversations: [],
      })),
      me: { userId: me.userId, spaceId: me.spaceId, name: me.name },
    };
    if (!isIntegrationsScopeCurrent(scope) || me.userId !== scope.userId) return;
    writeSavedFile(scope, "inbox", { key: scopeKey(scope, "inbox"), inbox });
  } catch {}
}

export async function savedChatsScope(): Promise<SavedChatsScope | null> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const selectionId = selectedSpaceId();
  const verified = await loadVerifiedIntegrationsScope();
  const spaceId = selectionId ?? (verified?.selectionId === null ? verified.spaceId : null);
  if (!verified || verified.apiBase !== apiBase || !spaceId) return null;
  return withSessionNamespace({
    apiBase,
    userId: verified.userId,
    spaceId,
    sessionGeneration: generation,
    selectionId,
  });
}

async function withSessionNamespace(
  scope: IntegrationsCacheScope,
): Promise<SavedChatsScope | null> {
  try {
    const namespace = await artifactCacheSession(await loadSessionToken());
    return isIntegrationsScopeCurrent(scope) ? { ...scope, namespace } : null;
  } catch {
    return null;
  }
}

export async function liveSavedChatsScope(): Promise<SavedChatsScope | null> {
  const saved = await savedChatsScope();
  if (saved) return saved;
  const verified = await integrationsCacheScope().catch(() => null);
  return verified ? withSessionNamespace(verified) : null;
}

export async function loadSavedInbox(): Promise<SavedInbox | null> {
  const scope = await savedChatsScope();
  return scope ? readSavedInbox(scope) : null;
}

export function saveInbox(
  verifiedLoad: IntegrationsCacheScope,
  navigation: MobileSpaceNavigation,
  me: MobileMe,
): void {
  if (!isIntegrationsScopeCurrent(verifiedLoad) || verifiedLoad.userId !== me.userId) return;
  const { sessionGeneration, ...verified } = verifiedLoad;
  void saveVerifiedIntegrationsScope(sessionGeneration, verified);
  void withSessionNamespace(verifiedLoad).then((scope) => {
    if (scope) writeSavedInbox(scope, navigation, me);
  });
}

export function savedThreadSnapshot(snapshot: MobileSnapshot): MobileSnapshot {
  const { cursor: _cursor, activeRuns: _activeRuns, computer: _computer, ...rest } = snapshot;
  return {
    ...rest,
    messages: snapshot.messages.slice(-SAVED_CHAT_MESSAGES),
    olderCursor: null,
    run: null,
  };
}

export function readSavedThread(scope: SavedChatsScope, target: string): MobileSnapshot | null {
  if (!isIntegrationsScopeCurrent(scope)) return null;
  try {
    const data = readJson(spaceFile(scope, target), scopeKey(scope, target));
    const snapshot = data?.snapshot as MobileSnapshot | undefined;
    if (
      !snapshot ||
      savedChatTarget(snapshot) !== target ||
      typeof snapshot.threadId !== "string" ||
      !isRows(snapshot.messages) ||
      !snapshot.messages.every(
        (message) => typeof message.role === "string" && Array.isArray(message.blocks),
      )
    )
      return null;
    return savedThreadSnapshot(snapshot);
  } catch {
    return null;
  }
}

function writeSavedFile(
  scope: SavedChatsScope,
  target: string,
  data: Record<string, unknown>,
): void {
  if (!isIntegrationsScopeCurrent(scope)) return;
  const text = JSON.stringify(data);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > SAVED_CHAT_MAX_BYTES) return;
  const file = spaceFile(scope, target);
  const files: File[] = [];
  const collect = (directory: Directory) => {
    for (const entry of directory.list()) {
      if (entry instanceof File) {
        if (entry.uri !== file.uri) files.push(entry);
      } else collect(entry);
    }
  };
  collect(new Directory(Paths.cache, ROOT));
  let total = bytes + files.reduce((sum, entry) => sum + entry.size, 0);
  files.sort((a, b) => (a.lastModified ?? 0) - (b.lastModified ?? 0));
  const inboxes = files.filter((entry) => entry.name === "inbox.json");
  const threads = files.filter((entry) => entry.name !== "inbox.json");
  const evict = (entries: File[]) => {
    const oldest = entries.shift();
    if (!oldest) throw new Error("Saved cache budget unavailable");
    const size = oldest.size;
    oldest.delete();
    total -= size;
  };
  if (target === "inbox") {
    while (inboxes.length >= SAVED_INBOXES) evict(inboxes);
  } else {
    while (threads.length >= SAVED_CHATS) evict(threads);
  }

  while (total > SAVED_CHATS_MAX_BYTES) evict(threads);
  file.create({ overwrite: true });
  file.write(text);
}

export function writeSavedThread(
  scope: SavedChatsScope,
  target: string,
  snapshot: MobileSnapshot,
): void {
  if (!isIntegrationsScopeCurrent(scope) || savedChatTarget(snapshot) !== target) return;
  try {
    writeSavedFile(scope, target, {
      key: scopeKey(scope, target),
      snapshot: savedThreadSnapshot(snapshot),
    });
  } catch {}
}

export function clearSavedChats(): void {
  try {
    const root = new Directory(Paths.cache, ROOT);
    if (root.exists) root.delete();
  } catch {}
}
