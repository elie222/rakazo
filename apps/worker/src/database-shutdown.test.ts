import { describe, expect, it, vi } from "vitest";
import { endDatabasePool } from "./database-shutdown.js";

describe("endDatabasePool", () => {
  it("stops waiting for a pool that still has a connection checked out", async () => {
    // pg-pool's end() waits for every checked-out client, such as Graphile's
    // listener whose unlisten never answers after the job host gave up on it.
    const pool = { end: vi.fn(() => new Promise<void>(() => undefined)) };
    const outcome = await Promise.race([
      endDatabasePool(pool, 25).then(() => "ended" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    expect(outcome).toBe("ended");
    expect(pool.end).toHaveBeenCalled();
  });

  it("waits for a pool that closes within the bound", async () => {
    let closed = false;
    const pool = {
      end: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            closed = true;
            resolve();
          }, 50),
        ),
    };
    await endDatabasePool(pool, 2_000);
    expect(closed).toBe(true);
  });
});
