export const message =
  "Do not set the height of a Button, SelectTrigger, OptionSelect, Input or InputGroup with a className (h-*, min-h-*, size-*). Pick its size prop instead: each size name is the same height on every control (packages/ui-web/src/lib/control-size.ts), so controls placed side by side line up. A control that grows with its content may use h-auto, with a min-h-* floor.";

export const include = [
  "apps/web/src/**/*.tsx",
  "apps/desktop/src/**/*.tsx",
  "packages/*/src/**/*.tsx",
];

export const exclude = ["**/*.{test,spec}.*", "**/*.stories.*"];

const OPENING = /<(Button|SelectTrigger|OptionSelect|InputGroup|Input)(?=[\s/><])/g;
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

const LITERAL = /"[^"]*"|'[^']*'|`[^`]*`/g;

/** The contents of every string literal in an expression. */
function literalsIn(expression) {
  return (expression.match(LITERAL) ?? []).map((literal) => literal.slice(1, -1));
}

/**
 * The class strings a tag's className can hold: the attribute's own string, or every string in
 * its expression and in the same-file constants that expression names.
 */
function classStrings(tag, constants) {
  const start = tag.search(/\bclassName=/);
  if (start === -1) return [];
  const valueStart = start + "className=".length;
  const open = tag[valueStart];
  if (open === '"' || open === "'") {
    return [tag.slice(valueStart + 1, tag.indexOf(open, valueStart + 1))];
  }
  if (open !== "{") return [];
  let depth = 0;
  let at = valueStart;
  for (; at < tag.length; at += 1) {
    if (tag[at] === "{") depth += 1;
    else if (tag[at] === "}" && --depth === 0) break;
  }
  const expression = tag.slice(valueStart + 1, at);
  const strings = literalsIn(expression);
  for (const name of expression.replace(LITERAL, "").match(/\b\w+\b/g) ?? []) {
    strings.push(...(constants.get(name) ?? []));
  }
  return strings;
}

/** A class sets the control's own height; one aimed at a child (`[&_svg]:size-4`) does not. */
function setsHeight(token) {
  const parts = token.split(/:(?![^[]*\])/);
  const base = parts.pop();
  if (parts.some((variant) => variant.startsWith("[&") || variant.startsWith("*"))) return false;
  return HEIGHT.test(base);
}

/**
 * The strings each same-file constant is built from (`const field = cn("mt-2", wide && "h-9")`).
 * A cva() variant map is a size prop's own definition, not an override.
 */
function classConstants(text) {
  const constants = new Map();
  for (const [, name, expression] of text.matchAll(
    /\bconst (\w+)\s*(?::[^=]+)?=\s*([\s\S]*?);\s*\n/g,
  )) {
    if (expression.startsWith("cva(")) continue;
    const strings = literalsIn(expression);
    if (strings.length > 0) constants.set(name, strings);
  }
  return constants;
}

export function count(text) {
  const hits = [];
  const constants = classConstants(text);
  for (const match of text.matchAll(OPENING)) {
    let from = match.index + match[0].length;
    // Step past type arguments (`<OptionSelect<Unit>`), whose `>` does not close the tag.
    if (text[from] === "<") from = text.indexOf(">", from) + 1;
    const tag = text.slice(match.index, tagEnd(text, from));
    const tokens = classStrings(tag, constants).flatMap((classes) => classes.split(/\s+/));
    const grows = tokens.includes("h-auto");
    const heights = tokens.filter(
      (token) => setsHeight(token) && !(grows && /^(?:h-auto|min-h-)/.test(token)),
    );
    if (heights.length === 0) continue;
    hits.push({
      line: text.slice(0, match.index).split("\n").length,
      text: `<${match[1]} className="${heights.join(" ")}">`,
    });
  }
  return hits;
}
