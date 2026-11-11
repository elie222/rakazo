import { beforeEach, describe, expect, it, vi } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";
import type { RoutineWatchDeps, RoutineWatchTarget } from "./routine-watch.js";
import { checkRoutineWatch, describeRoutineWatch } from "./routine-watch.js";

vi.mock("./computer-lifecycle.js", async (original) => ({
  ...(await original()),
  provisionComputer: vi.fn(),
}));

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];
const now = new Date("2026-03-01T12:00:00Z");

function setup(body = "ready", status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status }));
  const deps = { http: { fetch, resolveHostname: publicResolver } } as unknown as RoutineWatchDeps;
  const routine: RoutineWatchTarget = {
    id: "routine-1",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    watch: { kind: "http", url: "https://example.com/status" },
    watchState: null,
  };
  return { deps, routine, fetch };
}

beforeEach(() => vi.mocked(provisionComputer).mockClear());

describe("computer-free HTTP watches", () => {
  it("baselines, compares, and detects changes without provisioning a computer", async () => {
    const { deps, routine, fetch } = setup();
    const baseline = await checkRoutineWatch(deps, routine, now);
    expect(baseline).toMatchObject({ changed: false, state: { outcome: "baseline" } });
    const unchanged = await checkRoutineWatch(
      deps,
      { ...routine, watchState: baseline.state },
      now,
    );
    expect(unchanged).toMatchObject({ changed: false, state: { outcome: "unchanged" } });
    fetch.mockImplementationOnce(async () => new Response("changed"));
    expect(
      await checkRoutineWatch(deps, { ...routine, watchState: unchanged.state }, now),
    ).toMatchObject({
      changed: true,
      state: { outcome: "changed", detail: "changed" },
    });
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/status",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        dispatcher: expect.anything(),
        signal: expect.any(AbortSignal),
      }),
    );
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
  });

  it("ignores JSON key order and tracks only the configured fields", async () => {
    const { deps, routine, fetch } = setup('{"id":"a","updatedAt":1,"noise":1}');
    const baseline = await checkRoutineWatch(deps, routine, now);
    fetch.mockImplementationOnce(async () => new Response('{"noise":1,"updatedAt":1,"id":"a"}'));
    expect(
      (await checkRoutineWatch(deps, { ...routine, watchState: baseline.state }, now)).changed,
    ).toBe(false);
    routine.watch = { kind: "http", url: "https://example.com/status", track: ["id", "updatedAt"] };
    const tracked = await checkRoutineWatch(deps, routine, now);
    fetch.mockImplementationOnce(async () => new Response('{"id":"a","updatedAt":1,"noise":2}'));
    expect(
      (await checkRoutineWatch(deps, { ...routine, watchState: tracked.state }, now)).changed,
    ).toBe(false);
    fetch.mockImplementationOnce(async () => new Response('{"id":"a","updatedAt":2}'));
    expect(
      (await checkRoutineWatch(deps, { ...routine, watchState: tracked.state }, now)).changed,
    ).toBe(true);
  });

  it.each([301, 302, 401, 404, 500])(
    "fails status %s without following a redirect or comparing an error page",
    async (status) => {
      const { deps, routine, fetch } = setup("error", status);
      await expect(checkRoutineWatch(deps, routine, now)).rejects.toThrow(
        `HTTPS check returned status ${status}`,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "https://localhost/status",
    "https://127.0.0.1/status",
    "https://10.0.0.1/status",
    "https://[::1]/status",
    "https://169.254.169.254/latest/meta-data",
  ])("blocks private and metadata destinations %s before fetching", async (url) => {
    const { deps, routine, fetch } = setup();
    routine.watch = { kind: "http", url };
    await expect(checkRoutineWatch(deps, routine, now)).rejects.toThrow(
      "Could not check the HTTPS endpoint",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a public hostname whose DNS answers include a private address", async () => {
    const { deps, routine, fetch } = setup();
    deps.http!.resolveHostname = async () => [
      { address: "203.0.113.10", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
    await expect(checkRoutineWatch(deps, routine, now)).rejects.toThrow(
      "Could not check the HTTPS endpoint",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized responses instead of comparing truncated content", async () => {
    const { deps, routine } = setup("x".repeat(1_000_001));
    await expect(checkRoutineWatch(deps, routine, now)).rejects.toThrow("response is too large");
  });

  it("requires JSON when tracking fields", async () => {
    const { deps, routine } = setup();
    routine.watch = { kind: "http", url: "https://example.com/status", track: ["id"] };
    await expect(checkRoutineWatch(deps, routine, now)).rejects.toThrow("require a JSON response");
  });

  it("does not expose URL tokens through descriptions or transport errors", async () => {
    const { deps, routine, fetch } = setup();
    const watch = {
      kind: "http" as const,
      url: "https://example.com/status/fake-token",
      everyMinutes: 5,
      loud: false,
    };
    routine.watch = watch;
    expect(describeRoutineWatch(watch)).toBe("HTTPS endpoint");
    fetch.mockRejectedValueOnce(new Error(`Request timed out: ${watch.url}`));
    await expect(checkRoutineWatch(deps, routine, now)).rejects.toThrow(
      /^Could not check the HTTPS endpoint\.$/,
    );
  });
});
