import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyServerUpdate,
  assertNoGitApplyPath,
  checkServerUpdate,
  isUpdaterConfigured,
  MAX_UPDATER_RESPONSE_BYTES,
  readServerUpdateStatus,
  type UpdaterProxyConfig,
  UpdaterProxyError,
} from "./server-update.js";

const TOKEN = "fake-review-updater-token-000000000000";
const URL = "http://updater:7092";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("server update install kind", () => {
  async function tempRoot(withGit: boolean) {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-update-"));
    roots.push(root);
    if (withGit) await mkdir(path.join(root, ".git"));
    return root;
  }

  it("detects a source checkout when the sidecar is not wired", async () => {
    const root = await tempRoot(true);
    const status = await readServerUpdateStatus({
      url: null,
      token: null,
      gitSha: "abc",
      checkoutRoot: root,
      fetch: vi.fn(),
    });
    expect(status.installKind).toBe("source");
    expect(status.supported).toBe(false);
    expect(status.manualCommands.some((line) => line.includes("git pull"))).toBe(true);
    expect(status.manualCommands.some((line) => line.includes("migrate"))).toBe(true);
  });

  it("detects compose-without-sidecar when the updater URL is set but unreachable", async () => {
    const root = await tempRoot(false);
    const status = await readServerUpdateStatus({
      url: URL,
      token: TOKEN,
      gitSha: "abc",
      imageTag: "sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      checkoutRoot: root,
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    expect(status.installKind).toBe("compose");
    expect(status.supported).toBe(false);
    expect(status.manualCommands[0]).toMatch(/docker compose .*pull api worker web/);
    expect(status.manualCommands[1]).toMatch(/up -d --wait --pull never/);
  });

  it("shows rebuild commands for a compose install on the local image tag", async () => {
    const root = await tempRoot(false);
    const status = await readServerUpdateStatus({
      url: URL,
      token: TOKEN,
      gitSha: "abc",
      imageTag: "local",
      checkoutRoot: root,
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    expect(status.installKind).toBe("compose");
    expect(status.manualCommands.some((line) => line.includes("--build"))).toBe(true);
    expect(status.manualCommands.some((line) => line.includes("git pull"))).toBe(true);
    expect(status.manualCommands.some((line) => /\bpull api worker web\b/.test(line))).toBe(false);
  });

  it("detects sidecar when health and authenticated state succeed", async () => {
    const root = await tempRoot(false);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (href.endsWith("/state")) {
        return new Response(
          JSON.stringify({
            image: "ghcr.io/elie222/rakazo/app",
            currentTag: "sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            previousTag: "sha-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            running: false,
            checkout: {
              present: true,
              commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              branch: "main",
              remoteUrl: "https://github.com/elie222/rakazo",
              dirty: false,
              dirtyPaths: [],
            },
          }),
          { status: 200 },
        );
      }
      return new Response("missing", { status: 404 });
    });
    const status = await readServerUpdateStatus({
      url: URL,
      token: TOKEN,
      gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      checkoutRoot: root,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(status.installKind).toBe("sidecar");
    expect(status.supported).toBe(true);
    expect(status.canRollback).toBe(true);
    expect(status.manualCommands).toEqual([]);
    expect(status.imageTag).toMatch(/^sha-/);
    expect(status.lastRun).toBeNull();
  });

  it("surfaces a finished sidecar lastRun for recreate confirmation", async () => {
    const root = await tempRoot(false);
    const lastRun = {
      startedAt: "2026-08-27T21:00:00.000Z",
      finishedAt: "2026-08-27T21:01:00.000Z",
      ok: false,
      fromCommit: null,
      toCommit: null,
      fromTag: "sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      toTag: "sha-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      strategy: "pull",
      repoUrl: "https://github.com/elie222/rakazo",
      branch: "main",
      restart: "not-required",
      restartAdvice: "Recreate failed; prior image restored, env pin not restored.",
      error: "Recreate the stack failed.",
      steps: [],
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (href.endsWith("/state")) {
        return new Response(
          JSON.stringify({
            image: "ghcr.io/elie222/rakazo/app",
            currentTag: "sha-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            previousTag: "sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            running: false,
            lastRun,
            checkout: {
              present: true,
              commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              branch: "main",
              remoteUrl: "https://github.com/elie222/rakazo",
              dirty: false,
              dirtyPaths: [],
            },
          }),
          { status: 200 },
        );
      }
      return new Response("missing", { status: 404 });
    });
    const status = await readServerUpdateStatus({
      url: URL,
      token: TOKEN,
      gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      checkoutRoot: root,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(status.lastRun).toMatchObject({
      ok: false,
      fromTag: "sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      toTag: "sha-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      error: "Recreate the stack failed.",
    });
  });
});

describe("sidecar proxy auth and no-git-apply", () => {
  it("requires both URL and token before claiming the sidecar is configured", () => {
    expect(isUpdaterConfigured({ url: URL, token: null, gitSha: undefined })).toBe(false);
    expect(isUpdaterConfigured({ url: null, token: TOKEN, gitSha: undefined })).toBe(false);
    expect(isUpdaterConfigured({ url: URL, token: TOKEN, gitSha: undefined })).toBe(true);
  });

  it("sends the bearer token to the sidecar and never returns it", async () => {
    const authHeaders: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = String(input);
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization");
      if (authorization) authHeaders.push(authorization);
      if (href.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (href.endsWith("/state")) {
        return new Response(JSON.stringify({ running: false, currentTag: "local" }), {
          status: 200,
        });
      }
      if (href.endsWith("/plan")) {
        return new Response(
          JSON.stringify({
            upToDate: false,
            targetCommit: "cccccccccccccccccccccccccccccccccccccccc",
            targetTag: "sha-cccccccccccccccccccccccccccccccccccccccc",
            checkout: { commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", dirty: false },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    });
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-proxy-"));
    roots.push(root);
    const config: UpdaterProxyConfig = {
      url: URL,
      token: TOKEN,
      gitSha: undefined,
      checkoutRoot: root,
      fetch: fetchImpl as unknown as typeof fetch,
    };
    const check = await checkServerUpdate(config);
    expect(check.status).toBe("available");
    expect(authHeaders).toContain(`Bearer ${TOKEN}`);
    expect(JSON.stringify(check)).not.toContain(TOKEN);
  });

  it("rejects check/apply when the sidecar is off (no git apply path)", async () => {
    const config: UpdaterProxyConfig = {
      url: null,
      token: null,
      gitSha: undefined,
      fetch: vi.fn(),
    };
    await expect(checkServerUpdate(config)).rejects.toBeInstanceOf(UpdaterProxyError);
    await expect(applyServerUpdate(config)).rejects.toMatchObject({
      message: expect.stringMatching(/sidecar/i),
    });
    expect(assertNoGitApplyPath).toBeTypeOf("function");
    expect(() => assertNoGitApplyPath("source")).toThrow(/cannot apply/);
    expect(() => assertNoGitApplyPath("compose")).toThrow(/cannot apply/);
    expect(() => assertNoGitApplyPath("sidecar")).not.toThrow();
  });

  it("maps a 401 from the sidecar without exposing the token", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    });
    const config: UpdaterProxyConfig = {
      url: URL,
      token: TOKEN,
      gitSha: undefined,
      fetch: fetchImpl as unknown as typeof fetch,
    };
    await expect(applyServerUpdate(config)).rejects.toMatchObject({
      message: expect.stringMatching(/credential|reachable|sidecar/i),
    });
    await expect(applyServerUpdate(config)).rejects.not.toMatchObject({
      message: expect.stringContaining(TOKEN),
    });
  });

  it("rejects an oversized declared sidecar response without waiting for cancellation", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.endsWith("/health")) return Response.json({ ok: true });
      if (href.endsWith("/state")) return Response.json({ running: false });
      return new Response(new ReadableStream({ cancel }), {
        status: 200,
        headers: { "content-length": String(MAX_UPDATER_RESPONSE_BYTES + 1) },
      });
    });

    await expect(
      applyServerUpdate({
        url: URL,
        token: TOKEN,
        gitSha: undefined,
        fetch: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      message: "The updater sidecar response is too large.",
      status: 502,
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("rejects a streamed sidecar response once it crosses the byte limit", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.endsWith("/health")) return Response.json({ ok: true });
      if (href.endsWith("/state")) return Response.json({ running: false });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_UPDATER_RESPONSE_BYTES + 1));
          },
        }),
        { status: 200 },
      );
    });

    await expect(
      applyServerUpdate({
        url: URL,
        token: TOKEN,
        gitSha: undefined,
        fetch: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      message: "The updater sidecar response is too large.",
      status: 502,
    });
  });
});
