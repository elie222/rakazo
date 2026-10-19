import { beforeEach, expect, it, vi } from "vitest";
import type { MobileMe, MobileSnapshot, MobileSpaceNavigation } from "./api";
import type { SavedChatsScope } from "./saved-chats";
import {
  clearSavedChats,
  loadSavedInbox,
  readSavedInbox,
  readSavedThread,
  SAVED_CHAT_MAX_BYTES,
  SAVED_CHAT_MESSAGES,
  SAVED_CHATS,
  SAVED_CHATS_MAX_BYTES,
  savedChatsScope,
  writeSavedInbox,
  writeSavedThread,
} from "./saved-chats";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  written: new Map<string, number>(),
  current: true,
  verified: null as Omit<SavedChatsScope, "namespace"> | null,
  selection: "space-a" as string | null,
  namespace: "ns-1",
}));
vi.mock("./artifact-cache-session", () => ({ artifactCacheSession: async () => state.namespace }));
vi.mock("./api", () => ({
  currentApiBase: () => "https://api.example.test",
  selectedSpaceId: () => state.selection,
}));
vi.mock("./integrations-cache", () => ({
  isIntegrationsScopeCurrent: () => state.current,
  integrationsCacheScope: async () => {
    throw new Error("offline");
  },
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => 1,
  loadSessionToken: async () => "fake-token",
  loadVerifiedIntegrationsScope: async () => state.verified,
  saveVerifiedIntegrationsScope: vi.fn(),
}));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    get name() {
      return this.uri.split("/").at(-1)!;
    }
    get exists() {
      return [...state.files.keys()].some((path) => path.startsWith(`${this.uri}/`));
    }
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    create() {}
    list() {
      const names = new Set(
        [...state.files.keys()]
          .filter((path) => path.startsWith(`${this.uri}/`))
          .map((path) => path.slice(this.uri.length + 1).split("/")[0]!),
      );
      return [...names].map((name) =>
        state.files.has(`${this.uri}/${name}`) ? new File(this, name) : new Directory(this, name),
      );
    }
    delete() {
      for (const path of [...state.files.keys()]) {
        if (path.startsWith(`${this.uri}/`)) state.files.delete(path);
      }
    }
  }
  class File extends Directory {
    override get exists() {
      return state.files.has(this.uri);
    }
    override create() {}
    override delete() {
      state.files.delete(this.uri);
    }
    get lastModified() {
      return state.written.get(this.uri) ?? 0;
    }
    get size() {
      return new TextEncoder().encode(state.files.get(this.uri) ?? "").length;
    }
    textSync() {
      return state.files.get(this.uri);
    }
    write(value: string) {
      state.files.set(this.uri, value);
      state.written.set(this.uri, state.written.size + 1);
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});

const scope: SavedChatsScope = {
  apiBase: "https://api.example.test",
  userId: "user-a",
  spaceId: "space-a",
  sessionGeneration: 1,
  selectionId: "space-a",
  namespace: "ns-1",
};
const me = {
  userId: "user-a",
  spaceId: "space-a",
  name: "Ada Example",
  email: "ada@example.test",
} as MobileMe;
const bot = {
  id: "bot-a",
  name: "Alpha",
  title: "Research",
  notifyOnFinish: true,
  threadId: "thread-bot-a",
  updatedAt: "2026-10-10T12:30:00.000Z",
  sectionId: "section-a",
  parentBotId: "parent-a",
};
const group = {
  id: "group-a",
  name: "Team",
  members: [],
  preview: "",
  updatedAt: "2026-10-10T12:30:00.000Z",
};
const navigation = {
  current: {
    id: "space-a",
    name: "Personal",
    bots: [{ ...bot, instructions: "Private bot instructions", teamChatRules: "Private rules" }],
    groups: [{ ...group, createdAt: "2026-10-01T09:00:00.000Z" }],
    externalConversations: [],
    botSections: [],
  },
  spaces: [],
} as unknown as MobileSpaceNavigation;
function thread(count: number, botId = "bot-a"): MobileSnapshot {
  return {
    botId,
    threadId: `thread-${botId}`,
    cursor: 42,
    olderCursor: 7,
    run: { id: "run-a", status: "running" },
    activeRuns: [{ id: "run-a", status: "running" }],
    messages: Array.from({ length: count }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 ? "bot" : "user",
      blocks: [{ kind: "text", text: `message ${index}` }],
    })) as MobileSnapshot["messages"],
  };
}

beforeEach(() => {
  state.files.clear();
  state.written.clear();
  state.current = true;
  state.verified = null;
  state.selection = "space-a";
  state.namespace = "ns-1";
});

const verified = { ...scope };
it("round trips only what the inbox shows", () => {
  expect(readSavedInbox(scope)).toBeNull();
  writeSavedInbox(scope, navigation, me);
  expect(readSavedInbox(scope)?.bots).toEqual([bot]);
  expect(readSavedInbox(scope)?.groups).toEqual([group]);
  const [contents] = [...state.files.values()];
  expect(contents).not.toContain("Private");
  writeSavedThread(scope, "bot:bot-a", thread(SAVED_CHAT_MESSAGES + 1));
  const saved = readSavedThread(scope, "bot:bot-a")!;
  expect(saved.messages).toHaveLength(SAVED_CHAT_MESSAGES);
  expect(saved.run).toBeNull();
  expect(saved).not.toHaveProperty("cursor");
});

it.each([{ apiBase: "https://other.example.test" }, { userId: "user-b" }, { spaceId: "space-b" }])(
  "never reads another scope %j",
  (change) => {
    writeSavedInbox(scope, navigation, me);
    expect(readSavedInbox({ ...scope, ...change })).toBeNull();
  },
);

it("never reads what an earlier session of the same account left behind", async () => {
  // A wipe failed; signing in again rotates the namespace, so the old files are unreachable.
  state.verified = verified;
  writeSavedThread((await savedChatsScope())!, "bot:bot-a", thread(2));
  writeSavedInbox((await savedChatsScope())!, navigation, me);
  state.namespace = "ns-2";
  expect(readSavedThread((await savedChatsScope())!, "bot:bot-a")).toBeNull();
  expect(await loadSavedInbox()).toBeNull();
});

it("rejects oversized files on both write and read", () => {
  const huge = thread(1);
  huge.messages[0]!.blocks = [{ kind: "text", text: "x".repeat(SAVED_CHAT_MAX_BYTES) }];
  writeSavedThread(scope, "bot:bot-a", huge);
  expect(state.files.size).toBe(0);
  writeSavedThread(scope, "bot:bot-a", thread(1));
  const path = [...state.files.keys()][0]!;
  state.files.set(path, "x".repeat(SAVED_CHAT_MAX_BYTES + 1));
  expect(readSavedThread(scope, "bot:bot-a")).toBeNull();
});

it("caps total bytes across Spaces before admitting another transcript", () => {
  for (let index = 0; index < 40; index++) {
    const snapshot = thread(1, `bot-${index}`);
    snapshot.messages[0]!.blocks = [{ kind: "text", text: "x".repeat(700_000) }];
    writeSavedThread({ ...scope, spaceId: `space-${index}` }, `bot:bot-${index}`, snapshot);
  }
  const bytes = [...state.files.values()].reduce(
    (sum, text) => sum + new TextEncoder().encode(text).length,
    0,
  );
  expect(bytes).toBeLessThanOrEqual(SAVED_CHATS_MAX_BYTES);
  expect(state.files.size).toBeLessThan(SAVED_CHATS);
  expect(readSavedThread(scope, "bot:bot-0")).toBeNull();
});

it("clears everything", () => {
  writeSavedInbox(scope, navigation, me);
  writeSavedThread(scope, "bot:bot-a", thread(1));
  clearSavedChats();
  expect(state.files.size).toBe(0);
  expect(readSavedInbox(scope)).toBeNull();
});
