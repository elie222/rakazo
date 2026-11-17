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
// Camel-case names count too when a part says it holds a reply (`slackReply`, `replyText`). Generic
// parts such as `Text` stay out: `lastText` also holds the product's own fixed notices.
const PROSE_WORDS =
  "reply|replies|answer|memory|message|messages|summary|transcript|instructions|description";
const capitalized = PROSE_WORDS.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const PROSE = new RegExp(
  `\\b(?:text|texts|body|content|said|${PROSE_WORDS})\\b|\\b(?:${PROSE_WORDS})[A-Z]|[a-z](?:${capitalized})\\b|\\bfiles?\\s*[([]`,
);
// A string search with a literal (a template literal without `${}` counts), or a matcher in an assertion; `?.` calls count the same as `.`.
// A keyword held in a constant (`reply.includes(KEYWORD)`) is not followed: constants here also
// hold the product's own fixed markers, which are not model prose.
const STRING_SEARCH =
  /\??\.(?:includes|startsWith|endsWith|indexOf|toContain|toMatch)\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`$\\\n]|\\.)*`|\/(?:[^/\\\n]|\\.)+\/[a-z]*)/g;
// A regex literal tested against or matched by something.
const REGEX_TEST = /(\/(?:[^/\\\n*]|\\.)(?:[^/\\\n]|\\.)*\/[a-z]*)\??\.(?:test|exec)\(/g;
const REGEX_MATCH = /\??\.(?:match|matchAll|search)\(\s*(\/(?:[^/\\\n]|\\.)+\/[a-z]*)/g;
// A tool-choice matcher (`"~words"`) on a setting the bot writes in its own words.
const PROSE_MATCHER = /\b(?:instructions|description)\s*:\s*["']~/g;

/** Whether a literal looks for natural-language words rather than an identifier or exact value. */
export function seeksWords(literal) {
  if (literal.startsWith("/")) {
    const source = literal.slice(1, literal.lastIndexOf("/"));
    // An anchored pattern with no alternatives or open spans compares the whole value, like ===;
    // `^.*words.*$` is still a search for words.
    if (/^\^[^|]*\$$/.test(source) && !/(?:\.|\[\^?(?:[^\]\\]|\\.)*\])[*+]/.test(source))
      return false;
    const plain = source.replace(/\\[a-zA-Z]/g, " ").replace(/\(\?[:=!<]+/g, " ");
    return plain.split(/[^A-Za-z0-9_.\-/]+/).some(isWord);
  }
  const tokens = literal
    .slice(1, -1)
    .replace(/^~/, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/[.,;:!?]+$/, ""));
  // A phrase is mostly words; one token that looks like code or a marker (`ZD-1842`, `rpt_v3`,
  // `[tool`) makes it an identifier.
  if (tokens.some((token) => /[^A-Za-z'-]|[A-Z]{2}/.test(token))) return false;
  const words = tokens.filter(
    (token) => /^[A-Za-z][a-z]*(?:'[a-z]+)?$/.test(token) && token.length > 1,
  );
  return words.length > 0 && words.length * 2 >= tokens.length;
}

// A lowercase dictionary-style word: no digits, separators or ALL-CAPS code (`ZD-1842`, `rpt_v3`).
const isWord = (token) => /^[A-Za-z][a-z]{2,}$/.test(token);

/** What a call is made on: its own line, and earlier lines when the call continues them. */
function receiver(text, index) {
  let start = text.lastIndexOf("\n", index - 1) + 1;
  for (let lines = 0; start > 0 && lines < 4; lines += 1) {
    const previousStart = text.lastIndexOf("\n", start - 2) + 1;
    const previous = text.slice(previousStart, start - 1).trimEnd();
    if (!/^\??[.)\]]/.test(text.slice(start, index + 2).trimStart()) && !/[(=]$/.test(previous))
      break;
    start = previousStart;
  }
  return text.slice(start, index);
}

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
  for (const match of text.matchAll(STRING_SEARCH))
    if (PROSE.test(receiver(text, match.index)) && seeksWords(match[1])) hit(match.index);
  for (const match of text.matchAll(REGEX_TEST))
    if (PROSE.test(argument(text, match.index + match[0].length)) && seeksWords(match[1]))
      hit(match.index);
  for (const match of text.matchAll(REGEX_MATCH))
    if (PROSE.test(receiver(text, match.index)) && seeksWords(match[1])) hit(match.index);
  for (const match of text.matchAll(PROSE_MATCHER)) hit(match.index);
  return hits.sort((a, b) => a.line - b.line);
}
