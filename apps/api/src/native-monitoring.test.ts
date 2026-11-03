import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { monitoringRoutes } from "./monitoring.js";
import { sanitizeNativeEnvelope, sanitizeNativeEvent } from "./native-monitoring.js";

const DSN = "https://key@errors.example.com/8";
const encoder = new TextEncoder();
function envelope(event: unknown, attachment = false) {
  const json = JSON.stringify(event);
  const lines = [
    "{}",
    JSON.stringify({ type: "event", length: encoder.encode(json).length }),
    json,
  ];
  if (attachment) lines.push(JSON.stringify({ type: "attachment", length: 14 }), "private\nmemory");
  return encoder.encode(lines.join("\n") + "\n");
}

describe("native error collector privacy boundary", () => {
  it("keeps only recognized mobile platforms for distinguishing startup failures", () => {
    for (const platform of ["ios", "android"])
      expect(sanitizeNativeEvent({ tags: { "mobile.platform": platform } }, "mobile").tags).toEqual(
        { surface: "mobile", "mobile.platform": platform },
      );
    for (const platform of ["private-device", "https://private.example.com"])
      expect(sanitizeNativeEvent({ tags: { "mobile.platform": platform } }, "mobile").tags).toEqual(
        { surface: "mobile" },
      );
    expect(sanitizeNativeEvent({ tags: { "mobile.platform": "ios" } }, "desktop").tags).toEqual({
      surface: "desktop",
    });
  });

  it("keeps which desktop child process stopped", () => {
    const tags = { "process.name": "Audio Service", "process.exit_code": "-1" };
    expect(sanitizeNativeEvent({ tags }, "desktop").tags).toEqual({ surface: "desktop", ...tags });
    expect(sanitizeNativeEvent({ tags }, "mobile").tags).toEqual({ surface: "mobile" });
    expect(
      sanitizeNativeEvent(
        { tags: { "process.name": "/Users/someone/app", "process.exit_code": "private text" } },
        "desktop",
      ).tags,
    ).toEqual({ surface: "desktop" });
  });

  it("keeps replayed startup failures anonymous", () => {
    const event = sanitizeNativeEvent(
      {
        platform: "javascript",
        user: { id: "a".repeat(64) },
        tags: { "startup.previous_launch": "true", operation: "mobile.startup" },
      },
      "mobile",
    );
    expect(event).toMatchObject({
      user: { ip_address: null },
      tags: { "startup.previous_launch": "true", operation: "mobile.startup", surface: "mobile" },
    });
  });

  it("filters native events before forwarding and strips binary attachments, contexts and identity", async () => {
    const bytes = envelope(
      {
        platform: "cocoa",
        user: { id: "a".repeat(64) },
        contexts: { electron: { crashed_url: "https://app.example.com/?token=private" } },
        tags: { prompt: "private" },
        exception: {
          values: [
            {
              type: "NativeCrash",
              value: "Bearer secret",
              mechanism: { data: { secret: "private" } },
              stacktrace: {
                frames: [
                  { filename: "/Users/example/a.swift", vars: { secret: "private" }, lineno: 10 },
                ],
              },
            },
          ],
        },
      },
      true,
    );
    const result = new TextDecoder().decode(
      await sanitizeNativeEnvelope(gzipSync(bytes), "gzip", "mobile", { dsn: DSN }),
    );
    expect(result).not.toMatch(/private|secret|example\/a|attachment|contexts|crashed_url/);
    const event = JSON.parse(result.split("\n")[2]!);
    expect(event.exception.values[0].stacktrace.frames[0]).toEqual({
      filename: "/[user]/a.swift",
      lineno: 10,
    });
    expect(event.user).toEqual({ ip_address: null });
  });

  it("retains validated JS correlation and pseudonyms while rejecting raw identities", () => {
    const event = sanitizeNativeEvent(
      {
        platform: "javascript",
        user: { id: "a".repeat(64) },
        tags: { "trace.id": "b".repeat(32), operation: "voice.turn", secret: "private" },
      },
      "mobile",
    );
    expect(event).toMatchObject({
      user: { id: "a".repeat(64), ip_address: null },
      tags: { "trace.id": "b".repeat(32), operation: "voice.turn", surface: "mobile" },
    });
    expect(sanitizeNativeEvent({ user: { id: "raw-account" } }, "desktop").user).toEqual({
      ip_address: null,
    });
  });

  it("rejects malformed lengths, gzip bombs and attachment-only envelopes", async () => {
    for (const data of [
      encoder.encode('{}\n{"type":"event","length":999}\n{}'),
      encoder.encode('{}\n{"type":"attachment"}\nprivate'),
    ])
      await expect(
        sanitizeNativeEnvelope(data, undefined, "mobile", { dsn: DSN }),
      ).rejects.toThrow();
    await expect(
      sanitizeNativeEnvelope(gzipSync("x".repeat(2 * 1024 * 1024)), "gzip", "mobile", { dsn: DSN }),
    ).rejects.toThrow();
  });

  it("forwards only to the configured collector and preserves retry headers", async () => {
    const fetchImpl = vi.fn(
      async (_input: unknown, _init?: RequestInit) =>
        new Response(null, { status: 429, headers: { "retry-after": "60" } }),
    );
    const app = monitoringRoutes(
      { dsn: DSN, environment: "production" },
      fetchImpl as typeof fetch,
    );
    const response = await app.request("/api/monitoring/native/mobile/api/0/envelope/", {
      method: "POST",
      body: envelope({ message: "crash" }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://errors.example.com/api/8/envelope/?sentry_key=key",
      expect.objectContaining({ method: "POST" }),
    );
    const forwarded = new TextDecoder().decode(fetchImpl.mock.calls[0]![1]?.body as Uint8Array);
    expect(JSON.parse(forwarded.split("\n")[2]!).environment).toBe("production");
    const off = monitoringRoutes(undefined, fetchImpl as typeof fetch);
    expect(
      (await off.request("/api/monitoring/native/mobile/api/0/envelope/", { method: "POST" }))
        .status,
    ).toBe(404);
  });
});
