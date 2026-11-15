((root, factory) => {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DiffUtil = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function toLines(text) {
    if (text === null || text === undefined) return null;
    if (text === "") return [];
    // Split into lines but do not create a phantom trailing empty line for a final newline
    const parts = text.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts;
  }

  // Simple LCS-based line diff. null means "file did not exist".
  function diffLines(beforeText, afterText) {
    const a = toLines(beforeText);
    const b = toLines(afterText);
    const A = a === null ? [] : a;
    const B = b === null ? [] : b;
    const n = A.length,
      m = B.length;
    const dp = Array(n + 1)
      .fill(null)
      .map(() => Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0,
      j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        out.push({ type: "ctx", a: i + 1, b: j + 1, text: A[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ type: "del", a: i + 1, b: null, text: A[i++] });
      } else {
        out.push({ type: "add", a: null, b: j + 1, text: B[j++] });
      }
    }
    while (i < n) out.push({ type: "del", a: i + 1, b: null, text: A[i++] });
    while (j < m) out.push({ type: "add", a: null, b: j + 1, text: B[j++] });
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
    let add = 0,
      del = 0;
    for (const r of d) {
      if (r.type === "add") add++;
      else if (r.type === "del") del++;
    }
    return { add, del, kind: "modified" };
  }

  return { toLines, diffLines, diffStats };
});
