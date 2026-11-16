export const message =
  "Do not grade what a model wrote by matching words in it. Keep deterministic checks for effects, identifiers and exact structured values, and send the meaning to the suite's LLM judge: add a `judge` to the case with a versioned rubric and reviewed calibration labels (see packages/testkit/src/evals/judge.ts and grading.ts).";

export const include = [
  "packages/testkit/src/{evals,flows}/**/*.{ts,mts,js,mjs}",
  "packages/testkit/src/**/*.{canary,e2e,live}.test.ts",
  "**/{evals,scenarios}/**/*.{ts,mts,js,mjs}",
  "**/*.{eval,scenario}.{ts,mts,js,mjs}",
];

// Unit tests of a grader feed it fixed text; what they assert is the grader, not a model.
export const exclude = ["**/{evals,flows,scenarios}/**/*.test.*"];

// Names that hold what a model wrote: replies, saved files, memory, messages and bot settings.
const PROSE =
  /\b(?:text|texts|reply|replies|answer|memory|body|content|instructions|description|summary|message|messages|transcript|said)\b|\bfiles?\s*[([]/;
// A string search with a literal, or a matcher in an assertion.
const STRING_SEARCH =
  /\.(?:includes|startsWith|endsWith|indexOf|toContain|toMatch)\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\/(?:[^/\\\n]|\\.)+\/[a-z]*)/g;
// A regex literal tested against or matched by something.
const REGEX_TEST = /(\/(?:[^/\\\n*]|\\.)(?:[^/\\\n]|\\.)*\/[a-z]*)\.(?:test|exec)\(/g;
const REGEX_MATCH = /\.(?:match|matchAll|search)\(\s*(\/(?:[^/\\\n]|\\.)+\/[a-z]*)/g;
// A tool-choice matcher (`"~words"`) on a setting the bot writes in its own words.
const PROSE_MATCHER = /\b(?:instructions|description)\s*:\s*["']~/g;

/** Whether a literal looks for natural-language words rather than an identifier or exact value. */
export function seeksWords(literal) {
  if (literal.startsWith("/")) {
    const source = literal.slice(1, literal.lastIndexOf("/"));
    // An anchored pattern with no alternatives compares the whole value, like ===.
    if (/^\^[^|]*\$$/.test(source)) return false;
    const plain = source.replace(/\\[a-zA-Z]/g, " ").replace(/\(\?[:=!<]+/g, " ");
    return plain.split(/[^A-Za-z0-9_.\-/]+/).some(isWord);
  }
  const value = literal.slice(1, -1).replace(/^~/, "");
  return value.split(/\s+/).every(isWord) && value.trim() !== "";
}

// A lowercase dictionary-style word: no digits, separators or ALL-CAPS code (`ZD-1842`, `rpt_v3`).
const isWord = (token) => /^[A-Za-z][a-z]{2,}$/.test(token);

/** The call's argument text from just after its opening parenthesis, across lines. */
function argument(text, start) {
  let depth = 1;
  for (let at = start; at < text.length && at < start + 400; at += 1) {
    if (text[at] === "(") depth += 1;
    else if (text[at] === ")" && --depth === 0) return text.slice(start, at);
  }
  return text.slice(start, start + 400);
}

export function count(text) {
  const hits = [];
  const lines = text.split("\n");
  const hit = (index) => {
    const line = text.slice(0, index).split("\n").length;
    hits.push({ line, text: lines[line - 1].trim() });
  };
  for (const match of text.matchAll(STRING_SEARCH)) {
    const before = text.slice(text.lastIndexOf("\n", match.index) + 1, match.index);
    if (PROSE.test(before) && seeksWords(match[1])) hit(match.index);
  }
  for (const match of text.matchAll(REGEX_TEST))
    if (PROSE.test(argument(text, match.index + match[0].length)) && seeksWords(match[1]))
      hit(match.index);
  for (const match of text.matchAll(REGEX_MATCH)) {
    const before = text.slice(text.lastIndexOf("\n", match.index) + 1, match.index);
    if (PROSE.test(before) && seeksWords(match[1])) hit(match.index);
  }
  for (const match of text.matchAll(PROSE_MATCHER)) hit(match.index);
  return hits.sort((a, b) => a.line - b.line);
}
