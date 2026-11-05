import { describe, expect, it, vi } from "vitest";
import {
  createBackgroundJobHandlers,
  createPostgresMemoryCaptureLock,
} from "./background-job-handlers.js";

function connection(acquired = true) {
  return {
    connect: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string, _values: string[]) => ({
      rows: [sql.includes("pg_try_advisory_lock") ? { acquired } : { released: true }],
    })),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

describe("Postgres turn-memory capture lock", () => {
  it("uses the injected lock in the background handler and returns when the conversation is busy", async () => {
    const client = connection(false);
    const resolveTurnMemory = vi.fn();
    const findMany = vi.fn();
    const handlers = createBackgroundJobHandlers({
      prisma: {
        run: {
          findUnique: vi.fn(async () => ({
            id: "run-1",
            spaceId: "space-1",
            userId: "user-1",
            threadId: "thread-1",
            botId: "bot-1",
            status: "completed",
            memoryCaptureDueAt: new Date("2026-11-04T10:00:00Z"),
            memoryCapturedAt: null,
          })),
          findMany,
        },
      },
      memoryProviders: { resolveTurnMemory },
      memoryCaptureLock: createPostgresMemoryCaptureLock("unused-test-connection", () => client),
    } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);

    await expect(handlers["memory.capture"]({ runId: "run-1" })).resolves.toBeUndefined();

    expect(client.query.mock.calls).toEqual([
      [
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        ["memory.capture:thread-1:bot-1"],
      ],
    ]);
    expect(findMany).not.toHaveBeenCalled();
    expect(resolveTurnMemory).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("acquires and releases on the same dedicated connection around the drain", async () => {
    const client = connection();
    const lock = createPostgresMemoryCaptureLock("unused-test-connection", () => client);
    const drain = vi.fn(async () => {
      expect(client.query).toHaveBeenCalledTimes(1);
      expect(client.end).not.toHaveBeenCalled();
      return "drained";
    });

    await expect(lock("memory.capture:thread:bot", drain)).resolves.toEqual({
      acquired: true,
      value: "drained",
    });

    expect(client.query.mock.calls).toEqual([
      [
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        ["memory.capture:thread:bot"],
      ],
      [
        "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
        ["memory.capture:thread:bot"],
      ],
    ]);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.removeListener).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("does not drain or unlock someone else's lock when acquisition fails", async () => {
    const client = connection(false);
    const drain = vi.fn();
    const lock = createPostgresMemoryCaptureLock("unused-test-connection", () => client);

    await expect(lock("memory.capture:thread:bot", drain)).resolves.toEqual({ acquired: false });

    expect(drain).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("releases and closes after a failed drain without wrapping its failure", async () => {
    const client = connection();
    const lock = createPostgresMemoryCaptureLock("unused-test-connection", () => client);
    const failure = new Error("retryable capture");

    await expect(
      lock("memory.capture:thread:bot", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(client.query.mock.calls[1]?.[0]).toContain("pg_advisory_unlock");
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("closes a session even if the explicit unlock fails", async () => {
    const client = connection();
    client.query.mockImplementation(async (sql) => {
      if (sql.includes("pg_advisory_unlock")) throw new Error("connection reset");
      return { rows: [{ acquired: true }] };
    });
    const lock = createPostgresMemoryCaptureLock("unused-test-connection", () => client);

    await expect(lock("memory.capture:thread:bot", async () => 1)).resolves.toEqual({
      acquired: true,
      value: 1,
    });
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("closes after an acquisition error without reflecting connection details", async () => {
    const client = connection();
    client.connect.mockRejectedValue(new Error("fixture-private-connection-details"));
    const lock = createPostgresMemoryCaptureLock("unused-test-connection", () => client);
    const drain = vi.fn();

    await expect(lock("memory.capture:thread:bot", drain)).rejects.toThrow(
      "Turn memory capture lock unavailable",
    );
    expect(drain).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("contends only on the requested conversation across independent connections", async () => {
    const held = new Set<string>();
    const clients: ReturnType<typeof connection>[] = [];
    const lock = createPostgresMemoryCaptureLock("unused-test-connection", () => {
      const client = connection();
      client.query.mockImplementation(async (sql, values) => {
        const key = values[0]!;
        if (sql.includes("pg_try_advisory_lock")) {
          const acquired = !held.has(key);
          if (acquired) held.add(key);
          return { rows: [{ acquired }] };
        }
        return { rows: [{ released: held.delete(key) }] };
      });
      clients.push(client);
      return client;
    });
    let release = () => {};
    let started = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = lock("memory.capture:thread:bot-a", async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await running;
    const duplicate = vi.fn();

    await expect(lock("memory.capture:thread:bot-a", duplicate)).resolves.toEqual({
      acquired: false,
    });
    await expect(lock("memory.capture:thread:bot-b", async () => "other")).resolves.toEqual({
      acquired: true,
      value: "other",
    });
    expect(duplicate).not.toHaveBeenCalled();
    release();
    await first;

    expect(held.size).toBe(0);
    expect(clients).toHaveLength(3);
    expect(clients.every((client) => client.end.mock.calls.length === 1)).toBe(true);
  });
});
