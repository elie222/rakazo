import { deferred, flush } from "@rakazo/core/test-async";
import type { FetchQueryOptions, QueryObserverOptions } from "@tanstack/react-query";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountRpcQuery, persisted, queryClient, rpcQuery } from "./query";
import {
  clearSavedReads,
  keepSavedReads,
  SAVED_READ_MAX_BYTES,
  SAVED_READS_MAX_BYTES,
} from "./saved-reads";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  written: new Map<string, number>(),
  base: "https://api.example.test",
  space: "space-a" as string | null,
  generation: 1,
  verified: null as null | {
    apiBase: string;
    userId: string;
    spaceId: string;
    selectionId: string | null;
  },
  rpc: vi.fn(),
  loadVerified: vi.fn(),
}));
vi.mock("../api/api", () => ({
  currentApiBase: () => state.base,
  selectedSpaceId: () => state.space,
  captureApiRequestContext: async () => ({ apiBase: state.base, headers: {} }),
  rpc: state.rpc,
}));
vi.mock("../api/session", () => ({
  currentSessionGeneration: () => state.generation,
  loadVerifiedScope: state.loadVerified,
}));
vi.mock("../api/verified-scope", () => ({
  verifiedScope: async () => {
    if (!state.verified) throw new Error("offline");
    return { ...state.verified, sessionGeneration: state.generation };
  },
}));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
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
    writeSync(value: string) {
      state.files.set(this.uri, value);
      state.written.set(this.uri, state.written.size + 1);
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});

keepSavedReads(queryClient);

const app = {
  connectorId: "test",
  slug: "example",
  name: "Example app",
  logo: null,
  connected: true,
  noAuth: false,
};
const catalogRead = () => persisted(rpcQuery("connections/catalog"));
const unsubscribes: Array<() => void> = [];

/** Opens a read the way a screen does, and returns what it shows. */
function open(read: QueryObserverOptions) {
  const observer = new QueryObserver(queryClient, read);
  unsubscribes.push(observer.subscribe(() => undefined));
  return observer;
}

/** Answers once, then lets the answer reach the disk. */
async function answerAndSave(read: FetchQueryOptions, answer: unknown) {
  state.rpc.mockResolvedValueOnce(answer);
  const writes = state.written.size;
  await queryClient.fetchQuery(read);
  await vi.waitFor(() => expect(state.written.size).toBeGreaterThan(writes));
}

/** A new launch: nothing in memory, and the network has not answered yet. */
function relaunch() {
  for (const stop of unsubscribes.splice(0)) stop();
  queryClient.clear();
  state.generation += 1;
  state.rpc.mockReturnValue(new Promise(() => undefined));
}

beforeEach(() => {
  state.files.clear();
  state.written.clear();
  state.base = "https://api.example.test";
  state.space = "space-a";
  state.verified = {
    apiBase: state.base,
    userId: "user-a",
    spaceId: "space-a",
    selectionId: "space-a",
  };
  state.loadVerified.mockReset().mockImplementation(async () => state.verified);
  state.rpc.mockReset();
});
afterEach(() => {
  for (const stop of unsubscribes.splice(0)) stop();
  queryClient.clear();
});

it("paints a persisted answer on a fresh client before the network answers", async () => {
  await answerAndSave(catalogRead(), [app]);
  relaunch();
  const shown = open(catalogRead());
  await vi.waitFor(() => expect(shown.getCurrentResult().data).toEqual([app]));
  // Shown, never trusted: the read is still waiting on the network.
  expect(shown.getCurrentResult().isFetching).toBe(true);
  expect(shown.getCurrentResult().isStale).toBe(true);
});

it("keeps an error visible when the saved answer arrives after it", async () => {
  await answerAndSave(catalogRead(), [app]);
  relaunch();
  const verify = deferred<typeof state.verified>();
  state.loadVerified.mockReturnValue(verify.promise);
  state.rpc.mockRejectedValue(new Error("offline"));
  const shown = open(catalogRead());
  await vi.waitFor(() => expect(shown.getCurrentResult().isError).toBe(true));
  verify.resolve(state.verified);
  await vi.waitFor(() => expect(shown.getCurrentResult().data).toEqual([app]));
  expect(shown.getCurrentResult().isError).toBe(true);
});

it.each([
  ["server", () => Object.assign(state, { base: "https://other.example.test" })],
  ["user", () => Object.assign(state.verified!, { userId: "user-b" })],
  ["space", () => Object.assign(state, { space: "space-b" })],
])("never paints another %s's answer", async (_, change) => {
  await answerAndSave(catalogRead(), [app]);
  relaunch();
  change();
  if (state.verified) state.verified.apiBase = state.base;
  const shown = open(catalogRead());
  await vi.waitFor(() => expect(state.loadVerified).toHaveBeenCalled());
  await flush();
  expect(shown.getCurrentResult().data).toBeUndefined();
});

it("files account reads apart from any Space", async () => {
  const listRead = () => persisted(accountRpcQuery("connections/list"));
  await answerAndSave(listRead(), []);
  expect([...state.files.keys()][0]).toContain("/account/");
  relaunch();
  state.space = "space-b";
  const shown = open(listRead());
  await vi.waitFor(() => expect(shown.getCurrentResult().data).toEqual([]));
});

it("treats a saved answer that no longer matches the contract as a cold miss", async () => {
  await answerAndSave(catalogRead(), [app]);
  const [path, text] = [...state.files.entries()][0]!;
  state.files.set(path, JSON.stringify({ ...JSON.parse(text), data: [{ name: 1 }] }));
  relaunch();
  const shown = open(catalogRead());
  await vi.waitFor(() => expect(state.loadVerified).toHaveBeenCalled());
  await flush();
  expect(shown.getCurrentResult().data).toBeUndefined();
  state.files.set(path, "{");
  relaunch();
  const again = open(catalogRead());
  await flush();
  expect(again.getCurrentResult().data).toBeUndefined();
});

it("never touches the disk for a read that is not persisted", async () => {
  state.rpc.mockResolvedValue([app]);
  await queryClient.fetchQuery(rpcQuery("connections/catalog"));
  relaunch();
  open(rpcQuery("connections/catalog"));
  await flush();
  expect(state.files.size).toBe(0);
  expect(state.loadVerified).not.toHaveBeenCalled();
});

it("forgets every saved answer, and the old Integrations copy, on a session change", async () => {
  state.files.set("cache/integrations-v1/server/user-a/space-a.json", "{}");
  await answerAndSave(catalogRead(), [app]);
  clearSavedReads();
  expect(state.files.size).toBe(0);
  relaunch();
  const shown = open(catalogRead());
  await flush();
  expect(shown.getCurrentResult().data).toBeUndefined();
});

it("skips an oversized answer and drops the oldest to stay within the total", async () => {
  const big = (query: string, bytes: number) => ({
    read: persisted(rpcQuery("marketplace/catalog", { query })),
    answer: { entries: [], unavailableRegistries: ["x".repeat(bytes)], skippedEntries: 0 },
  });
  const tooBig = big("huge", SAVED_READ_MAX_BYTES);
  state.rpc.mockResolvedValueOnce(tooBig.answer);
  await queryClient.fetchQuery(tooBig.read);
  await flush();
  expect(state.files.size).toBe(0);

  const count = Math.floor(SAVED_READS_MAX_BYTES / (SAVED_READ_MAX_BYTES * 0.9)) + 1;
  for (let index = 0; index < count; index += 1) {
    const { read, answer } = big(`q${index}`, SAVED_READ_MAX_BYTES * 0.9);
    await answerAndSave(read, answer);
  }
  const total = [...state.files.values()].reduce((sum, text) => sum + text.length, 0);
  expect(total).toBeLessThanOrEqual(SAVED_READS_MAX_BYTES);
  expect([...state.files.keys()].some((path) => path.includes("q0"))).toBe(false);
  expect([...state.files.keys()].some((path) => path.includes(`q${count - 1}`))).toBe(true);
});
