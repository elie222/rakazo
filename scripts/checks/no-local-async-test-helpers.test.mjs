import assert from "node:assert/strict";
import { test } from "node:test";
import { count } from "./ratchets/no-local-async-test-helpers.mjs";

const lines = (text) => count(text).map((hit) => hit.line);

test("counts a promise whose executor only captures its resolvers", () => {
  const text = `function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
const save = vi.fn(() => new Promise<Array<{ done: () => void }>>((done) => (finish = done)));
const refused = new Promise<never>((_resolve, fail) => {
  state.reject = fail;
});`;
  assert.deepEqual(count(text), [
    { line: 4, text: "const promise = new Promise<T>((yes, no) => {" },
    { line: 11, text: "const gate = new Promise<void>((resolve) => {" },
    {
      line: 14,
      text: "const save = vi.fn(() => new Promise<Array<{ done: () => void }>>((done) => (finish = done)));",
    },
    { line: 15, text: "const refused = new Promise<never>((_resolve, fail) => {" },
  ]);
});

test("counts a resolver captured inside a closure that only calls it", () => {
  const text = `let abort = () => {};
const ready = new Promise<void>((_resolve, reject) => {
  abort = () => reject(new DOMException("Document hidden", "InvalidStateError"));
});
const answer = new Promise<ScreenAnswer>((resolve) => {
  release = () => resolve(screenAnswer());
});
send.mockReturnValue(new Promise((resolve) => (finish = (value) => resolve(value))));
const lost = new Promise((_, fail) => {
  state.fail = (error) => fail(error);
});`;
  assert.deepEqual(lines(text), [2, 5, 8, 9]);
});

test("ignores an event handler that settles the promise and a closure that does more", () => {
  const text = `await new Promise<void>((resolve) => {
  socket.onclose = () => resolve();
});
const gone = new Promise((_resolve, reject) => {
  pending = () => reject(signal.reason);
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});
const read = new Promise((resolve) => {
  release = () => resolve(value) || log("released");
});`;
  assert.deepEqual(lines(text), []);
});

test("ignores a promise whose executor does more than capture", () => {
  const text = `await new Promise<void>((resolve) => server.listen(0, resolve));
const closed = new Promise((resolve) => client.on("close", resolve));
const waiting = new Promise((resolve) => resolvers.push(resolve));
const read = new Promise<void>((resolve) => {
  finishRead = () => {
    unread = false;
    resolve();
  };
});
const started = new Promise<void>((resolve) => {
  begin = resolve;
  calls += 1;
});
const gate = deferred();`;
  assert.deepEqual(lines(text), []);
});

test("counts a promise resolved by a timer that is already due, and no real delay", () => {
  const text = `const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
await new Promise<void>((done) => setTimeout(done));
await act(async () => {
  await new Promise((r) => {
    setTimeout(r, 0);
  });
});
await new Promise((resolve) => setTimeout(() => resolve(), 0));
await new Promise((resolve) => setTimeout(resolve, 20));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setTimeout(() => resolve("late"), 0));
for (let i = 0; i < 10; i++) await Promise.resolve();
await flush();`;
  assert.deepEqual(lines(text), [1, 2, 4, 8]);
});

test("counts the loop that sleeps on a timer until a condition lets it leave", () => {
  const text = `async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}
for (const scope of scopes) {
  await prisma.$transaction(async (tx) => {
    while (Date.now() < deadline) {
      if (await blocked(tx)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  });
}
do {
  rows = await load();
  if (rows.length === 0) await new Promise((r) => setTimeout(r, 50));
  else break;
} while (true);`;
  assert.deepEqual(count(text), [
    { line: 2, text: "for (let attempt = 0; attempt < 500; attempt++) {" },
    { line: 10, text: "while (Date.now() < deadline) {" },
    { line: 16, text: "do {" },
  ]);
});

test("counts a loop that sleeps until its own condition changes, braced or not", () => {
  const text = `while (releases.length < 4) await new Promise((resolve) => setTimeout(resolve, 5));
while (!settled) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
while (true) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}`;
  assert.deepEqual(count(text), [
    { line: 1, text: "while (releases.length < 4) await new Promise((resolve) => setTimeout(" },
    { line: 2, text: "while (!settled) {" },
  ]);
});

test("ignores a sleep outside a loop, a paced loop that never leaves early, and vi.waitFor", () => {
  const text = `await new Promise((resolve) => setTimeout(resolve, 75));
for (const chunk of chunks) {
  res.write(chunk);
  await new Promise((resolve) => setTimeout(resolve, 100));
}
while (pending.length > 0) {
  if (pending.shift()?.done) break;
}
await vi.waitFor(() => expect(output).toMatch(pattern), { timeout: 5_000, interval: 20 });
await vi.waitUntil(() => rows.length > 0);`;
  assert.deepEqual(lines(text), []);
});
