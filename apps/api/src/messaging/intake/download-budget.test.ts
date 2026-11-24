import { flush } from "@rakazo/core/test-async";
import { describe, expect, it } from "vitest";
import { createDownloadBudget } from "./download-budget.js";

describe("createDownloadBudget", () => {
  it("holds a request that does not fit until a release makes room", async () => {
    const budget = createDownloadBudget(10);
    const started: string[] = [];
    const take = (name: string, bytes: number) =>
      budget.acquire(bytes).then((release) => {
        started.push(name);
        return release;
      });
    const releaseA = await take("a", 6);
    const b = take("b", 6);
    await flush();
    expect(started).toEqual(["a"]);

    releaseA();
    const releaseB = await b;
    expect(started).toEqual(["a", "b"]);
    releaseB();
  });

  it("runs a request larger than the budget alone", async () => {
    const budget = createDownloadBudget(10);
    const started: string[] = [];
    const releaseSmall = await budget.acquire(1);
    const large = budget.acquire(50).then((release) => {
      started.push("large");
      return release;
    });
    const after = budget.acquire(1).then((release) => {
      started.push("after");
      return release;
    });
    await flush();
    expect(started).toEqual([]);

    releaseSmall();
    const releaseLarge = await large;
    await flush();
    expect(started).toEqual(["large"]);
    releaseLarge();
    (await after)();
  });

  it("serves requests in arrival order, so a large one is not starved", async () => {
    const budget = createDownloadBudget(10);
    const started: string[] = [];
    const take = (name: string, bytes: number) =>
      budget.acquire(bytes).then((release) => {
        started.push(name);
        return release;
      });
    const releaseA = await take("a", 6);
    const big = take("big", 8);
    const small = take("small", 2);
    await flush();
    // "small" would fit beside "a", but "big" arrived first.
    expect(started).toEqual(["a"]);

    releaseA();
    (await big)();
    (await small)();
    expect(started).toEqual(["a", "big", "small"]);
  });

  it("removes a waiter that gave up without leaking what it asked for", async () => {
    const budget = createDownloadBudget(10);
    const releaseA = await budget.acquire(8);
    const giveUp = new AbortController();
    const abandoned = budget.acquire(8, giveUp.signal);
    const next = budget.acquire(2);
    giveUp.abort(new Error("out of time"));
    await expect(abandoned).rejects.toThrow("out of time");
    // Removing the waiter lets the one behind it, which fits, start.
    (await next)();

    releaseA();
    const all = await budget.acquire(10);
    all();
  });

  it("never grants a request whose signal already aborted", async () => {
    const budget = createDownloadBudget(10);
    const gone = AbortSignal.abort(new Error("gone"));
    await expect(budget.acquire(1, gone)).rejects.toThrow("gone");
    (await budget.acquire(10))();
  });

  it("ignores a second release of the same reservation", async () => {
    const budget = createDownloadBudget(10);
    const release = await budget.acquire(10);
    release();
    release();
    const first = await budget.acquire(6);
    const second = budget.acquire(6);
    await flush();
    first();
    (await second)();
  });
});
