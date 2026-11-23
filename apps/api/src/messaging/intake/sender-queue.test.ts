import { deferred, flush } from "@rakazo/core/test-async";
import { describe, expect, it } from "vitest";
import { createSenderQueue } from "./sender-queue.js";

describe("createSenderQueue", () => {
  it("runs one sender's tasks one after another, in arrival order", async () => {
    const queue = createSenderQueue();
    const first = deferred<string>();
    const started: string[] = [];
    const a = queue.run("sender-1", async () => {
      started.push("a");
      return first.promise;
    });
    const b = queue.run("sender-1", async () => {
      started.push("b");
      return "b";
    });
    await flush();
    expect(started).toEqual(["a"]);
    expect(queue.busy("sender-1")).toBe(true);

    first.resolve("a");
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
    expect(started).toEqual(["a", "b"]);
    await flush();
    expect(queue.busy("sender-1")).toBe(false);
  });

  it("runs different senders side by side", async () => {
    const queue = createSenderQueue();
    const held = deferred();
    const started: string[] = [];
    const a = queue.run("sender-1", async () => {
      started.push("a");
      await held.promise;
    });
    const b = queue.run("sender-2", async () => {
      started.push("b");
    });
    await expect(b).resolves.toBeUndefined();
    expect(started).toEqual(["a", "b"]);
    expect(queue.busy("sender-2")).toBe(false);
    held.resolve();
    await a;
  });

  it("does not let a failed task hold up the next", async () => {
    const queue = createSenderQueue();
    const failed = queue.run("sender-1", async () => {
      throw new Error("download failed");
    });
    const next = queue.run("sender-1", async () => "delivered");
    await expect(failed).rejects.toThrow("download failed");
    await expect(next).resolves.toBe("delivered");
  });
});
