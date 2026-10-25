import type { Bot } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { importAsFirstBot } from "./first-bot-import";

/** A lock that runs one callback at a time, like the Web Lock shared by tabs. */
function serialLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
}

describe("importing an agent as the first bot", () => {
  it("imports under the first bot's spawn key when no first bot exists", async () => {
    const importCreate = vi.fn(async () => ({ id: "imported" }) as Bot);
    const result = await importAsFirstBot(
      {
        lock: serialLock(),
        existing: async () => undefined,
        spawnKey: "onboarding:first",
        importCreate,
      },
      { name: "Pebble" },
    );
    expect(result).toEqual({ bot: { id: "imported" }, imported: true });
    expect(importCreate).toHaveBeenCalledWith({ name: "Pebble", spawnKey: "onboarding:first" });
  });

  it("never makes a second first bot when another tab got there first", async () => {
    const lock = serialLock();
    const bots: { id: string }[] = [];
    const existing = async () => bots[0];
    // The other tab's Chief, created under the same lock.
    const chief = lock(async () => {
      bots.push({ id: "chief" });
      return bots[0]!;
    });
    const importCreate = vi.fn(async () => ({ id: "imported" }) as Bot);
    const result = await importAsFirstBot(
      { lock, existing, spawnKey: "onboarding:first", importCreate },
      { name: "Pebble" },
    );
    await chief;
    expect(result).toEqual({ bot: { id: "chief" }, imported: false });
    expect(importCreate).not.toHaveBeenCalled();
    expect(bots).toEqual([{ id: "chief" }]);
  });

  it("reports not imported when another device made the first bot meanwhile", async () => {
    let made: { id: string } | undefined;
    const importCreate = vi.fn(async () => {
      made = { id: "chief" };
      throw Object.assign(new Error("Your first bot already exists."), {
        code: "CONFLICT",
        data: { reason: "first_bot_exists" },
      });
    });
    const result = await importAsFirstBot(
      {
        lock: serialLock(),
        existing: async () => made,
        spawnKey: "onboarding:first",
        importCreate,
      },
      { name: "Pebble" },
    );
    expect(result).toEqual({ bot: { id: "chief" }, imported: false });
  });
});
