import type { Deferred } from "@rakazo/core/test-async";
import { deferred, flush } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import { PART_CONCURRENCY, uploadParts } from "./object-storage-common.js";

async function* rest(...values: string[]) {
  for (const value of values) yield Buffer.from(value);
}

/** Holds every part upload open until the test releases it; `refuse` parts fail when released. */
function heldUploads(refuse: number[] = []) {
  const started: number[] = [];
  const settled: number[] = [];
  const held = new Map<number, Deferred<void>>();
  const upload = async (bytes: Buffer, partNumber: number) => {
    started.push(partNumber);
    const gate = deferred();
    held.set(partNumber, gate);
    await gate.promise;
    settled.push(partNumber);
    if (refuse.includes(partNumber)) throw new Error(`part ${partNumber} refused`);
    return { partNumber, body: bytes.toString() };
  };
  return { started, settled, held, upload };
}

describe("uploadParts", () => {
  it("sends several parts at once and answers in part order", async () => {
    expect(PART_CONCURRENCY).toBe(3);
    const { started, held, upload } = heldUploads();
    const result = uploadParts(
      [Buffer.from("a"), Buffer.from("b")],
      rest("c", "d", "e")[Symbol.asyncIterator](),
      upload,
    );
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    held.get(2)?.resolve();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3, 4]));
    for (const part of [3, 1, 4]) held.get(part)?.resolve();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3, 4, 5]));
    held.get(5)?.resolve();
    expect(await result).toEqual([
      { partNumber: 1, body: "a" },
      { partNumber: 2, body: "b" },
      { partNumber: 3, body: "c" },
      { partNumber: 4, body: "d" },
      { partNumber: 5, body: "e" },
    ]);
  });

  it("starts no part after a failure and throws once the parts in flight settle", async () => {
    const { started, settled, held, upload } = heldUploads([1]);
    const outcome = uploadParts(
      [Buffer.from("a"), Buffer.from("b")],
      rest("c", "d", "e")[Symbol.asyncIterator](),
      upload,
    ).catch((error: Error) => error.message);
    let thrown = false;
    void outcome.then(() => {
      thrown = true;
    });
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    held.get(1)?.resolve();
    await vi.waitFor(() => expect(settled).toEqual([1]));
    held.get(2)?.resolve();
    await vi.waitFor(() => expect(settled).toEqual([1, 2]));
    await flush();
    expect(thrown).toBe(false);
    held.get(3)?.resolve();
    expect(await outcome).toBe("part 1 refused");
    expect(settled).toEqual([1, 2, 3]);
    expect(started).toEqual([1, 2, 3]);
  });

  it("throws a failing source only once the parts in flight settle", async () => {
    const { started, settled, held, upload } = heldUploads();
    const source = (async function* () {
      yield Buffer.from("c");
      throw new Error("source failed");
    })();
    const outcome = uploadParts([Buffer.from("a"), Buffer.from("b")], source, upload).catch(
      (error: Error) => error.message,
    );
    let thrown = false;
    void outcome.then(() => {
      thrown = true;
    });
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    held.get(1)?.resolve();
    await vi.waitFor(() => expect(settled).toEqual([1]));
    await flush();
    expect(thrown).toBe(false);
    held.get(2)?.resolve();
    held.get(3)?.resolve();
    expect(await outcome).toBe("source failed");
    expect(settled).toEqual([1, 2, 3]);
  });
});
