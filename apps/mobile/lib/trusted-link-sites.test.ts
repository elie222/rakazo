import { beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "./query";
import {
  loadTrustedLinkSites,
  removeTrustedLinkSite,
  trustedLinkSitesRead,
  trustLinkSite,
} from "./trusted-link-sites";

const scope = vi.hoisted(() => ({
  apiBase: "https://app.example.test",
  generation: 1,
  spaceId: "space-a" as string | null,
  rpc: vi.fn(),
}));
vi.mock("./api", () => ({
  currentApiBase: () => scope.apiBase,
  selectedSpaceId: () => scope.spaceId,
  captureApiRequestContext: async () => ({ apiBase: scope.apiBase, headers: {} }),
  loadSessionToken: async () => "token",
  rpc: scope.rpc,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => scope.generation }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  queryClient.clear();
  scope.apiBase = "https://app.example.test";
  scope.generation = 1;
  scope.spaceId = "space-a";
  scope.rpc.mockReset();
});

it("reads the list once for every space", async () => {
  scope.rpc.mockResolvedValue(["example.com"]);
  await loadTrustedLinkSites();
  scope.spaceId = "space-b";
  expect(queryClient.getQueryData(trustedLinkSitesRead().queryKey)).toEqual(["example.com"]);

  scope.rpc.mockResolvedValue({ site: "alice.github.io" });
  await trustLinkSite("https://alice.github.io/page");
  scope.spaceId = "space-a";
  expect(queryClient.getQueryData(trustedLinkSitesRead().queryKey)).toEqual([
    "alice.github.io",
    "example.com",
  ]);
  scope.rpc.mockResolvedValue({ ok: true });
  await removeTrustedLinkSite("example.com");
  expect(queryClient.getQueryData(trustedLinkSitesRead().queryKey)).toEqual(["alice.github.io"]);
});

it("keeps a trust reply that lands after a session change out of the new session's list", async () => {
  const reply = deferred<{ site: string }>();
  scope.rpc.mockReturnValue(reply.promise);
  const trusting = trustLinkSite("https://example.com/page");
  await vi.waitFor(() => expect(scope.rpc).toHaveBeenCalled());

  // Another user signs in: the session moves on and the cache is cleared.
  scope.generation = 2;
  queryClient.clear();
  reply.resolve({ site: "example.com" });
  await trusting;

  expect(queryClient.getQueryData(trustedLinkSitesRead().queryKey)).toBeUndefined();
});

it("reads the whole list again when a site is trusted before the first read lands", async () => {
  scope.rpc.mockImplementation(async (path: string) =>
    path === "trustedLinkSites/trust"
      ? { site: "alice.github.io" }
      : ["alice.github.io", "example.com"],
  );
  await trustLinkSite("https://alice.github.io/page");

  await vi.waitFor(() =>
    expect(queryClient.getQueryData(trustedLinkSitesRead().queryKey)).toEqual([
      "alice.github.io",
      "example.com",
    ]),
  );
});
