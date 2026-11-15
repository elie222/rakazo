const assert = require("node:assert");
const { toLines, diffLines, diffStats } = require("./diff.cjs");

function test(name, fn) {
  try {
    fn();
    console.log("PASS", name);
  } catch (e) {
    console.error("FAIL", name);
    console.error(e.stack || e);
    process.exitCode = 1;
  }
}

test("toLines: null stays null", () => {
  assert.strictEqual(toLines(null), null);
});
test("toLines: empty string -> []", () => {
  assert.deepStrictEqual(toLines(""), []);
});
test("toLines: strips single trailing newline", () => {
  assert.deepStrictEqual(toLines("a\nb\n"), ["a", "b"]);
  assert.deepStrictEqual(toLines("a\n"), ["a"]);
});
test("toLines: preserves internal empties, no phantom trailing", () => {
  assert.deepStrictEqual(toLines("a\n\nb\n"), ["a", "", "b"]);
});

test("diff new file: all additions, no spurious deletion", () => {
  const d = diffLines(null, "hello\nworld\n");
  assert.deepStrictEqual(d, [
    { type: "add", a: null, b: 1, text: "hello" },
    { type: "add", a: null, b: 2, text: "world" },
  ]);
  assert.deepStrictEqual(diffStats(null, "hello\nworld\n"), { add: 2, del: 0, kind: "new" });
});

test("diff deleted file: all deletions", () => {
  const d = diffLines("a\nb\n", null);
  assert.deepStrictEqual(d, [
    { type: "del", a: 1, b: null, text: "a" },
    { type: "del", a: 2, b: null, text: "b" },
  ]);
  assert.deepStrictEqual(diffStats("a\nb\n", null), { add: 0, del: 2, kind: "deleted" });
});

test("diff modified file: correct add/del/ctx", () => {
  const before = "name: Routine\nsteps:\n  - Stretch\n    duration_min: 20\nnotes: ok\n";
  const after =
    "name: Routine\nsteps:\n  - Stretch\n    duration_min: 10\n  - Journal\n    duration_min: 10\nnotes: ok\n";
  const d = diffLines(before, after);
  const adds = d.filter((x) => x.type === "add");
  const dels = d.filter((x) => x.type === "del");
  assert.strictEqual(dels.length, 1);
  assert.strictEqual(dels[0].text, "    duration_min: 20");
  assert.strictEqual(adds.length, 3);
  assert.ok(adds.some((x) => x.text === "    duration_min: 10"));
  assert.ok(adds.some((x) => x.text === "  - Journal"));
  assert.deepStrictEqual(diffStats(before, after), { add: 3, del: 1, kind: "modified" });
});

test("diff identical: all context", () => {
  const t = "a\nb\n";
  const d = diffLines(t, t);
  assert.ok(d.every((x) => x.type === "ctx"));
  assert.deepStrictEqual(diffStats(t, t), { add: 0, del: 0, kind: "modified" });
});

test("diff empty new file: no lines", () => {
  assert.deepStrictEqual(diffLines(null, ""), []);
  assert.deepStrictEqual(diffStats(null, ""), { add: 0, del: 0, kind: "new" });
});

if (process.exitCode) process.exit(1);
console.log("All tests passed");
