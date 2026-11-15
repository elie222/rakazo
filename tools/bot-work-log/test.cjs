const assert = require("node:assert");
const { toLines, diffLines, diffStats, MAX_LCS_CELLS } = require("./diff.cjs");

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
  assert.deepStrictEqual(diffStats(t, t), { add: 0, del: 0, kind: "unchanged" });
});

test("diff empty new file: no lines", () => {
  assert.deepStrictEqual(diffLines(null, ""), []);
  assert.deepStrictEqual(diffStats(null, ""), { add: 0, del: 0, kind: "new" });
});

test("diff: adding only the final newline is a change", () => {
  const d = diffLines("a", "a\n");
  assert.deepStrictEqual(
    d.map((r) => r.type),
    ["del", "add"],
  );
  assert.strictEqual(d[0].noEol, true);
  assert.strictEqual(d[1].noEol, undefined);
  assert.deepStrictEqual(diffStats("a", "a\n"), { add: 1, del: 1, kind: "modified" });
  assert.deepStrictEqual(diffStats("a\n", "a"), { add: 1, del: 1, kind: "modified" });
});

test("diff: same text without final newline is unchanged", () => {
  assert.deepStrictEqual(diffStats("a\nb", "a\nb"), { add: 0, del: 0, kind: "unchanged" });
});

test("diff: only the last line changes when neither side ends in a newline", () => {
  const d = diffLines("a\nb", "a\nc");
  assert.deepStrictEqual(
    d.map((r) => `${r.type}:${r.text}`),
    ["ctx:a", "del:b", "add:c"],
  );
});

test("diff: trimmed prefix and suffix keep correct line numbers", () => {
  const d = diffLines("a\nb\nc\nd\n", "a\nb\nX\nY\nd\n");
  assert.deepStrictEqual(d, [
    { type: "ctx", a: 1, b: 1, text: "a" },
    { type: "ctx", a: 2, b: 2, text: "b" },
    { type: "del", a: 3, b: null, text: "c" },
    { type: "add", a: null, b: 3, text: "X" },
    { type: "add", a: null, b: 4, text: "Y" },
    { type: "ctx", a: 4, b: 5, text: "d" },
  ]);
});

test("diff: a one-line edit in a huge file stays line-level", () => {
  const lines = Array.from({ length: 50000 }, (_, i) => `line ${i}`);
  const edited = lines.slice();
  edited[25000] = "changed";
  const stats = diffStats(`${lines.join("\n")}\n`, `${edited.join("\n")}\n`);
  assert.deepStrictEqual(stats, { add: 1, del: 1, kind: "modified" });
});

test("diff: huge unrelated files fall back to a coarse removed/added block", () => {
  const side = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 10;
  const a = Array.from({ length: side }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: side }, (_, i) => `b${i}`).join("\n");
  const d = diffLines(a, b);
  assert.strictEqual(d.filter((r) => r.type === "del").length, side);
  assert.strictEqual(d.filter((r) => r.type === "add").length, side);
  assert.ok(d.every((r) => r.type !== "ctx"));
});

test("diff: a line that looks like an end-of-file marker is still a real edit", () => {
  for (const marker of ["\u0000no-eol", "\\ No newline at end of file", "x\u0000no-eol"]) {
    assert.deepStrictEqual(diffStats("x", `x${marker}\n`), { add: 1, del: 1, kind: "modified" });
    assert.deepStrictEqual(diffStats(`x${marker}`, "x"), { add: 1, del: 1, kind: "modified" });
    assert.deepStrictEqual(diffStats(`x${marker}\n`, `x${marker}`), {
      add: 1,
      del: 1,
      kind: "modified",
    });
  }
});

test("diffStats: undefined means a missing file, like null", () => {
  assert.deepStrictEqual(diffStats(undefined, "x\n"), { add: 1, del: 0, kind: "new" });
  assert.deepStrictEqual(diffStats("x\n", undefined), { add: 0, del: 1, kind: "deleted" });
  assert.deepStrictEqual(diffStats(undefined, undefined), { add: 0, del: 0, kind: "none" });
  assert.deepStrictEqual(diffStats(undefined, null), { add: 0, del: 0, kind: "none" });
});

test("diffStats counts match diffLines rows", () => {
  const cases = [
    ["a\nb\nc\n", "a\nX\nc\nd\n"],
    ["a", "a\n"],
    ["", "x\n"],
    ["same\n", "same\n"],
    [
      Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n"),
      Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n"),
    ],
  ];
  for (const [before, after] of cases) {
    const rows = diffLines(before, after);
    const stats = diffStats(before, after);
    assert.strictEqual(stats.add, rows.filter((r) => r.type === "add").length);
    assert.strictEqual(stats.del, rows.filter((r) => r.type === "del").length);
  }
});

if (process.exitCode) process.exit(1);
console.log("All tests passed");
