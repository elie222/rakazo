import * as SecureStore from "expo-secure-store";
import * as Sharing from "expo-sharing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  secure: new Map<string, string>(),
  generation: 0,
  apiBase: "https://api.example.test",
  userId: "user-a",
  token: "fake-token-a",
  getSize: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("expo-file-system", () => {
  class Node {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get name() {
      return this.uri.split("/").at(-1)!;
    }
    get exists() {
      return state.files.has(this.uri);
    }
    create() {
      state.files.set(this.uri, "");
    }
    delete() {
      state.files.delete(this.uri);
    }
  }
  class File extends Node {
    write(value: string) {
      state.files.set(this.uri, value);
    }
    textSync() {
      return state.files.get(this.uri) ?? "";
    }
    text() {
      return Promise.resolve(this.textSync());
    }
    copySync() {}
  }
  class Directory extends Node {}
  return { File, Directory, Paths: { cache: { uri: "file:///cache" } } };
});
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => state.secure.get(key) ?? null),
  deleteItemAsync: vi.fn(async (key: string) => {
    state.secure.delete(key);
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    state.secure.set(key, value);
  }),
}));
vi.mock("react-native", () => ({ Image: { getSize: state.getSize } }));
vi.mock("expo-sharing", () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
vi.mock("./i18n", () => ({ t: (value: string) => value }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  loadSessionToken: async () => state.token,
}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  currentApiBase: () => state.apiBase,
  selectedSpaceId: () => null,
  captureApiRequestContext: async () => ({
    apiBase: state.apiBase,
    headers: { authorization: `Bearer ${state.token}` },
  }),
}));

const target = { botId: "bot-1" };
const load = () => import("./artifact-open");
const artifactFetches = () =>
  state.rpc.mock.calls.filter(([proc]) => proc === "artifacts/get").length;

beforeEach(() => {
  vi.resetModules();
  state.files.clear();
  state.secure.clear();
  state.generation = 0;
  state.apiBase = "https://api.example.test";
  state.userId = "user-a";
  state.token = "fake-token-a";
  state.rpc
    .mockReset()
    .mockImplementation(async (proc: string) =>
      proc === "me" ? { userId: state.userId } : { contentBase64: "aGk=" },
    );
  state.getSize.mockReset().mockImplementation((_uri, success) => success(2000, 1000));
});

describe("artifact preview caches", () => {
  it("keeps the large-payload download timeout and captured auth context", async () => {
    const api = await load();
    await api.readMobileArtifactText(target, "art-1", "text/plain");
    expect(state.rpc).toHaveBeenCalledWith(
      "artifacts/get",
      { ...target, artifactId: "art-1" },
      {
        timeoutMs: api.ARTIFACT_DOWNLOAD_TIMEOUT_MS,
        requestContext: {
          apiBase: state.apiBase,
          headers: { authorization: "Bearer fake-token-a" },
        },
      },
    );
    expect(api.ARTIFACT_DOWNLOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("shares concurrent dimensions and downloads and reuses disk after restart", async () => {
    let api = await load();
    const preview = () => api.imageArtifactPreview(target, "art-1", "image/png");
    const [a, b] = await Promise.all([preview(), preview()]);
    expect(a).toEqual(b);
    expect(a.size).toEqual({ width: 2000, height: 1000 });
    await preview();
    expect(state.getSize).toHaveBeenCalledTimes(1);
    expect(artifactFetches()).toBe(1);
    vi.resetModules();
    api = await load();
    expect(await preview()).toEqual(a);
    expect(state.getSize).toHaveBeenCalledTimes(2);
    expect(artifactFetches()).toBe(1);
  });

  it("downloads previews, text, and attachments without persisted cache metadata", async () => {
    let api = await load();
    const stored = await api.imageArtifactPreview(target, "art-1", "image/png");
    vi.resetModules();
    api = await load();
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked"));
    const fresh = await api.imageArtifactPreview(target, "art-1", "image/png");
    expect(fresh.uri).not.toBe(stored.uri);
    expect(fresh.size).toEqual(stored.size);
    expect(await api.readMobileArtifactText(target, "art-2", "text/plain")).toBe("aGk=");
    vi.mocked(Sharing.isAvailableAsync).mockResolvedValueOnce(true);
    await api.openMobileArtifact(target, "art-3", "attachment.pdf", "application/pdf");
    expect(Sharing.shareAsync).toHaveBeenCalledWith(expect.any(String), {
      mimeType: "application/pdf",
    });
    await api.imageArtifactPreview(target, "art-1", "image/png");
    expect(artifactFetches()).toBe(4);
    vi.resetModules();
    api = await load();
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked"));
    const restarted = await api.imageArtifactPreview(target, "art-1", "image/png");
    expect(restarted.uri).not.toBe(stored.uri);
    expect(restarted.uri).not.toBe(fresh.uri);
    expect(artifactFetches()).toBe(5);
  });

  it("models 20 previews, three remount cycles, and a restart", async () => {
    let api = await load();
    const mount = () =>
      Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          Promise.all([
            api.imageArtifactPreview(target, `art-${index}`, "image/png"),
            api.imageArtifactUri(target, `art-${index}`, "image/png"),
          ]),
        ),
      );
    await mount();
    for (let cycle = 0; cycle < 3; cycle += 1) await mount();
    expect(state.getSize).toHaveBeenCalledTimes(20);
    expect(artifactFetches()).toBe(20);
    vi.resetModules();
    api = await load();
    await mount();
    expect(state.getSize).toHaveBeenCalledTimes(40);
    expect(artifactFetches()).toBe(20);
    expect(state.rpc.mock.calls.filter(([proc]) => proc === "me")).toHaveLength(2);
  });

  it("never reuses legacy unscoped files or missing/corrupt metadata", async () => {
    state.files.set("file:///cache/art-1.png", "untrusted");
    let api = await load();
    await api.imageArtifactUri(target, "art-1", "image/png");
    expect(artifactFetches()).toBe(1);
    for (const invalid of ["missing", "corrupt"]) {
      const sidecar = [...state.files.keys()].find((key) => key.endsWith("art-1.png.json"))!;
      if (invalid === "missing") state.files.delete(sidecar);
      else state.files.set(sidecar, "bad json");
      vi.resetModules();
      api = await load();
      await api.imageArtifactUri(target, "art-1", "image/png");
    }
    expect(artifactFetches()).toBe(3);
  });

  it("redownloads a purged file once for concurrent callers", async () => {
    const api = await load();
    const uri = await api.imageArtifactUri(target, "art-1", "image/png");
    state.files.delete(uri);
    await Promise.all([1, 2, 3].map(() => api.imageArtifactUri(target, "art-1", "image/png")));
    expect(artifactFetches()).toBe(2);
  });

  it.each(["endpoint", "account", "sign-out"])("invalidates reuse on %s", async (change) => {
    const api = await load();
    const first = await api.imageArtifactPreview(target, "art-1", "image/png");
    if (change === "endpoint") state.apiBase = "https://other.example.test";
    else {
      await (await import("./artifact-cache-session")).invalidateArtifactCacheSession();
      state.generation += 1;
      if (change === "account") {
        state.userId = "user-b";
        state.token = "fake-token-b";
      }
    }
    const next = await api.imageArtifactPreview(target, "art-1", "image/png");
    expect(next.uri).not.toBe(first.uri);
    expect(artifactFetches()).toBe(2);
    expect(state.getSize).toHaveBeenCalledTimes(2);
  });

  it("separates targets and artifact IDs that have the same sanitized filename", async () => {
    const api = await load();
    const uris = await Promise.all([
      api.imageArtifactUri(target, "art/1", "image/png"),
      api.imageArtifactUri(target, "art_1", "image/png"),
      api.imageArtifactUri({ groupId: "group-1" }, "art_1", "image/png"),
    ]);
    expect(new Set(uris).size).toBe(3);
    expect(artifactFetches()).toBe(3);
  });

  it("rejects a late old-account download without writing it", async () => {
    const api = await load();
    let finish!: (value: { contentBase64: string }) => void;
    state.rpc.mockImplementation(async (proc: string) =>
      proc === "me"
        ? { userId: state.userId }
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const pending = api.imageArtifactUri(target, "art-1", "image/png");
    await vi.waitFor(() => expect(finish).toBeDefined());
    state.generation += 1;
    finish({ contentBase64: "old-account" });
    await expect(pending).rejects.toThrow("Artifact session changed");
    expect([...state.files.values()]).not.toContain("old-account");
  });

  it("retries failed sizing and failed downloads", async () => {
    const api = await load();
    state.getSize.mockImplementationOnce((_uri, _success, failure) => failure(new Error("decode")));
    await expect(api.imageArtifactPreview(target, "art-1", "image/png")).rejects.toThrow("decode");
    await api.imageArtifactPreview(target, "art-1", "image/png");
    expect(state.getSize).toHaveBeenCalledTimes(2);
    state.rpc.mockRejectedValueOnce(new Error("offline"));
    await expect(api.imageArtifactUri(target, "art-2", "image/png")).rejects.toThrow("offline");
    await api.imageArtifactUri(target, "art-2", "image/png");
    expect(artifactFetches()).toBe(3);
  });
});
