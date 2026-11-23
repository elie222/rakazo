import { isDeepStrictEqual } from "node:util";

/** FastMCP-style servers serialize `structuredContent` into a text block too,
 * so the result budget would hold the same data twice. Drop a text block that
 * is exactly that serialization and keep the structured form: the result
 * serializer JSON-stringifies the envelope, where structured data stays plain
 * JSON instead of becoming a quoted, escaped JSON string. Differing text,
 * images and other blocks pass through untouched. Error results keep every
 * block: their text is the diagnostic audits and error readers report. */
export function withoutDuplicatedStructuredText(
  content: unknown,
  structured: unknown,
  isError: boolean,
): unknown {
  if (isError || structured === undefined || !Array.isArray(content)) return content;
  return content.filter((block) => !isStructuredTextDuplicate(block, structured));
}

function isStructuredTextDuplicate(block: unknown, structured: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const { type, text } = block as { type?: unknown; text?: unknown };
  return type === "text" && repeatsStructuredContent(text, structured);
}

function repeatsStructuredContent(text: unknown, structured: unknown): boolean {
  if (typeof text !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  // Parsing rounds both copies of an integer like 9007199254740993 to the same
  // double, so an equal comparison would drop the text that still carries the
  // exact digits the server sent.
  if (couldLoseNumericPrecision(text)) return false;
  return isDeepStrictEqual(parsed, structured);
}

/** Whether a JSON number in `text` does not survive the round-trip through a
 * JavaScript number: integers outside the safe range round to a nearby double,
 * huge exponents overflow to Infinity and tiny ones underflow to 0. Number
 * digits inside strings are skipped. */
function couldLoseNumericPrecision(text: string): boolean {
  const quote = '"'.charCodeAt(0);
  const backslash = "\\".charCodeAt(0);
  const minus = "-".charCodeAt(0);
  const zero = "0".charCodeAt(0);
  const nine = "9".charCodeAt(0);
  const numberChars = new Set([..."+-.eE0123456789"].map((char) => char.charCodeAt(0)));
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === backslash) escaped = true;
      else if (code === quote) inString = false;
      index += 1;
    } else if (code === quote) {
      inString = true;
      index += 1;
    } else if (code === minus || (code >= zero && code <= nine)) {
      let end = index + 1;
      while (end < text.length && numberChars.has(text.charCodeAt(end))) end += 1;
      if (numberLosesPrecision(text.slice(index, end))) return true;
      index = end;
    } else {
      index += 1;
    }
  }
  return false;
}

function numberLosesPrecision(token: string): boolean {
  const value = Number(token);
  if (!Number.isFinite(value)) return true; // 1e999 overflows to Infinity.
  if (/[.eE]/.test(token)) {
    if (value === 0) return /[1-9]/.test(token); // 1e-400 underflows to 0.
    // A double keeps any 15 significant digits exactly; more may round
    // (9.007199254740993e15, 1.0000000000000001).
    const digits = token
      .replace(/[eE].*$/, "")
      .replace(/\D/g, "")
      .replace(/^0+/, "")
      .replace(/0+$/, "");
    return digits.length > 15;
  }
  return !Number.isSafeInteger(value);
}
