export const message =
  "Do not set the height of a Button, SelectTrigger, OptionSelect or Input with a className (h-*, min-h-*, size-*). Pick its size prop instead: each size name is the same height on every control (packages/ui-web/src/lib/control-size.ts), so controls placed side by side line up. A control that grows with its content may use h-auto.";

export const include = [
  "apps/web/src/**/*.tsx",
  "apps/desktop/src/**/*.tsx",
  "packages/*/src/**/*.tsx",
];

export const exclude = ["**/*.{test,spec}.*", "**/*.stories.*"];

const OPENING = /<(Button|SelectTrigger|OptionSelect|Input)(?=[\s/>])/g;
const HEIGHT = /^!?(?:h|min-h|size)-/;

/** The end of the JSX opening tag that starts at `from`, skipping braces and strings. */
function tagEnd(text, from) {
  let depth = 0;
  let quote = null;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (quote) {
      if (char === "\\") at += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return at;
  }
  return text.length;
}

/** The value of the className attribute in a tag: a string, or the expression in braces. */
function classNameValue(tag) {
  const start = tag.search(/\bclassName=/);
  if (start === -1) return null;
  const valueStart = start + "className=".length;
  const open = tag[valueStart];
  if (open === '"' || open === "'")
    return tag.slice(valueStart + 1, tag.indexOf(open, valueStart + 1));
  if (open !== "{") return null;
  let depth = 0;
  for (let at = valueStart; at < tag.length; at += 1) {
    if (tag[at] === "{") depth += 1;
    else if (tag[at] === "}" && --depth === 0) return tag.slice(valueStart + 1, at);
  }
  return tag.slice(valueStart + 1);
}

/** A class sets the control's own height; one aimed at a child (`[&_svg]:size-4`) does not. */
function setsHeight(token) {
  const parts = token.split(/:(?![^[]*\])/);
  const base = parts.pop();
  if (parts.some((variant) => variant.startsWith("[&") || variant.startsWith("*"))) return false;
  return HEIGHT.test(base);
}

const LITERAL = /"[^"]*"|'[^']*'|`[^`]*`/g;

/** Class strings held in a constant (`const fieldClass = "..."`), so passing one is caught too. */
function classConstants(text) {
  const constants = new Map();
  for (const [, name, literal] of text.matchAll(/\bconst (\w+) =\s*("[^"]*"|`[^`]*`)/g)) {
    constants.set(name, literal);
  }
  return constants;
}

export function count(text) {
  const hits = [];
  const constants = classConstants(text);
  for (const match of text.matchAll(OPENING)) {
    const tag = text.slice(match.index, tagEnd(text, match.index + match[0].length));
    const value = classNameValue(tag);
    if (!value) continue;
    const literals = value.match(LITERAL) ?? (tag.includes('className="') ? [`"${value}"`] : []);
    for (const name of value.replace(LITERAL, "").match(/\b\w+\b/g) ?? []) {
      if (constants.has(name)) literals.push(constants.get(name));
    }
    const tokens = literals.flatMap((literal) => literal.slice(1, -1).split(/\s+/));
    if (tokens.includes("h-auto")) continue;
    const heights = tokens.filter(setsHeight);
    if (heights.length === 0) continue;
    hits.push({
      line: text.slice(0, match.index).split("\n").length,
      text: `<${match[1]} className="${heights.join(" ")}">`,
    });
  }
  return hits;
}
