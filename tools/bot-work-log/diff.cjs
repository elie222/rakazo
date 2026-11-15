((root, factory) => {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DiffUtil = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  // Above this many LCS cells (after trimming the shared prefix and suffix) the middle is
  // reported as one removed block plus one added block instead of a line-level diff.
  const MAX_LCS_CELLS = 4_000_000;
  const NO_EOL = "\u0000no-eol";

  function toLines(text) {
    if (text === null || text === undefined) return null;
    if (text === "") return [];
    // Split into lines but do not create a phantom trailing empty line for a final newline
    const parts = text.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts;
  }

  // Lines with a comparison key. A last line without a trailing newline never equals the same
  // text with one, so adding or removing the final newline shows up as a change.
  function toEntries(text) {
    const lines = toLines(text);
    if (lines === null) return [];
    const noEol = text !== "" && !text.endsWith("\n");
    return lines.map((line, i) => {
      const last = noEol && i === lines.length - 1;
      return { text: line, key: last ? line + NO_EOL : line, noEol: last };
    });
  }

  function row(type, a, b, entry) {
    const r = { type, a, b, text: entry.text };
    if (entry.noEol) r.noEol = true;
    return r;
  }

  // Line diff of ctx/add/del rows. null means "file did not exist".
  function diffLines(beforeText, afterText) {
    const A = toEntries(beforeText);
    const B = toEntries(afterText);
    const n = A.length;
    const m = B.length;

    let start = 0;
    while (start < n && start < m && A[start].key === B[start].key) start++;
    let end = 0;
    while (end < n - start && end < m - start && A[n - 1 - end].key === B[m - 1 - end].key) end++;

    const out = [];
    for (let k = 0; k < start; k++) out.push(row("ctx", k + 1, k + 1, A[k]));

    const an = n - start - end;
    const bm = m - start - end;
    if ((an + 1) * (bm + 1) > MAX_LCS_CELLS) {
      for (let i = 0; i < an; i++) out.push(row("del", start + i + 1, null, A[start + i]));
      for (let j = 0; j < bm; j++) out.push(row("add", null, start + j + 1, B[start + j]));
    } else {
      const width = bm + 1;
      const dp = new Uint32Array((an + 1) * width);
      for (let i = an - 1; i >= 0; i--) {
        for (let j = bm - 1; j >= 0; j--) {
          dp[i * width + j] =
            A[start + i].key === B[start + j].key
              ? dp[(i + 1) * width + j + 1] + 1
              : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < an && j < bm) {
        const x = A[start + i];
        const y = B[start + j];
        if (x.key === y.key) {
          out.push(row("ctx", start + i + 1, start + j + 1, x));
          i++;
          j++;
        } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
          out.push(row("del", start + i + 1, null, x));
          i++;
        } else {
          out.push(row("add", null, start + j + 1, y));
          j++;
        }
      }
      while (i < an) out.push(row("del", start + i + 1, null, A[start + i++]));
      while (j < bm) out.push(row("add", null, start + j + 1, B[start + j++]));
    }

    for (let k = 0; k < end; k++)
      out.push(row("ctx", n - end + k + 1, m - end + k + 1, A[n - end + k]));
    return out;
  }

  function diffStats(beforeText, afterText) {
    if (beforeText === null && afterText === null) return { add: 0, del: 0, kind: "none" };
    if (beforeText === null) {
      const lines = toLines(afterText) || [];
      return { add: lines.length, del: 0, kind: "new" };
    }
    if (afterText === null) {
      const lines = toLines(beforeText) || [];
      return { add: 0, del: lines.length, kind: "deleted" };
    }
    const d = diffLines(beforeText, afterText);
    let add = 0;
    let del = 0;
    for (const r of d) {
      if (r.type === "add") add++;
      else if (r.type === "del") del++;
    }
    return { add, del, kind: add === 0 && del === 0 ? "unchanged" : "modified" };
  }

  return { toLines, diffLines, diffStats, MAX_LCS_CELLS };
});
