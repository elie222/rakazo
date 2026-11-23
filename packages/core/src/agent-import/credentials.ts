/**
 * Text shaped like a well-known credential. Imported Markdown sometimes holds a key someone
 * pasted into a prompt or a note; an item with one starts unticked and says so, so it never
 * reaches a bot without the user choosing it. A chat message's keys are moved to the vault.
 *
 * Deterministic: each shape needs its provider's prefix and a minimum length. Only the two
 * generic shapes (`sk-` and `Bearer`) must also look random, so words and placeholders
 * ("sk-...", "sk-your-key-here", "Bearer <token>") do not count. A hyphenated word long
 * enough and with a digit ("sk-learn-…-v2-…") still does: over-flagging only unticks an item.
 */
const AWS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const AWS_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;
/** How far from an access key id an unnamed secret access key may sit. */
const AWS_NEARBY = 100;

const SHAPES: {
  pattern: RegExp;
  /** Only the first group must look random. */
  random?: boolean;
  /** The value is the first group, after a prefix such as `Bearer`. */
  group?: boolean;
  /** The match opens a block that runs to its END line, or to the end of the text. */
  block?: boolean;
}[] = [
  // OpenAI, Anthropic, OpenRouter and other `sk-` keys (`sk-proj-`, `sk-ant-`, `sk-or-v1-`).
  {
    pattern: /(?<![\w-])sk-(?:ant-(?:api\d\d-)?|or-v1-|proj-)?([A-Za-z0-9_-]{20,})/g,
    random: true,
  },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  // AWS access key ids, long-term (AKIA) and temporary (ASIA).
  { pattern: AWS_KEY_ID },
  // An AWS secret access key under the name the CLI, SDKs and STS answers give it.
  {
    pattern:
      /\b(?:aws[_-]?)?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi,
    random: true,
    group: true,
  },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { pattern: /\bhf_[A-Za-z0-9]{30,}/g },
  // Stripe live secret and restricted keys.
  { pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}/g },
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, block: true },
  { pattern: /\bbearer\s+([A-Za-z0-9._~+/-]{24,}=*)/gi, random: true, group: true },
];

function random(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value) && new Set(value).size > 4;
}

const BLOCK_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

export type TextRange = { start: number; end: number };

/** Where each credential-shaped value is in the text, in order, overlapping ones joined. */
export function credentialRanges(text: string): TextRange[] {
  return joinRanges(credentialMatches(text));
}

/** Each shape's match on its own, in no particular order; matches may overlap. */
export function credentialMatches(text: string): TextRange[] {
  const found: TextRange[] = [];
  for (const shape of SHAPES) {
    for (const match of text.matchAll(shape.pattern)) {
      if (shape.random && !random(match[1] ?? match[0])) continue;
      const end = match.index + match[0].length;
      if (shape.block) {
        BLOCK_END.lastIndex = end;
        const close = BLOCK_END.exec(text);
        found.push({
          start: match.index,
          end: close ? close.index + close[0].length : text.length,
        });
      } else {
        // A token that ends a sentence leaves the period out.
        let last = end;
        while (text[last - 1] === ".") last -= 1;
        found.push({ start: shape.group ? end - (match[1]?.length ?? 0) : match.index, end: last });
      }
    }
  }
  return [...found, ...awsSecretsBesideIds(text)];
}

/**
 * A 40-character secret access key pasted next to its access key id without a name, as the
 * console's download and most notes hold the pair. Mixed case and a digit leave out hex digests.
 */
function awsSecretsBesideIds(text: string): TextRange[] {
  const ids = [...text.matchAll(AWS_KEY_ID)].map((match) => match.index);
  if (!ids.length) return [];
  const found: TextRange[] = [];
  let next = 0;
  for (const match of text.matchAll(AWS_SECRET)) {
    const value = match[0];
    if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)) continue;
    const start = match.index;
    const end = start + value.length;
    // Both lists are in order, so ids that end too far before this value never count again.
    while (next < ids.length && (ids[next] ?? 0) + 20 < start - AWS_NEARBY) next++;
    const id = ids[next];
    if (id !== undefined && id <= end + AWS_NEARBY) found.push({ start, end });
  }
  return found;
}

/** The ranges in order, with overlapping ones joined. */
export function joinRanges(found: readonly TextRange[]): TextRange[] {
  const ranges: TextRange[] = [];
  for (const range of [...found].sort((a, b) => a.start - b.start)) {
    const last = ranges.at(-1);
    if (last && range.start < last.end) last.end = Math.max(last.end, range.end);
    else ranges.push({ ...range });
  }
  return ranges;
}

/** Never returns the value. */
export function looksLikeCredential(text: string): boolean {
  return credentialRanges(text).length > 0;
}
