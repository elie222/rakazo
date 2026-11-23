/**
 * The invisible characters that reorder text: bidi embeddings, overrides and isolates, plus the
 * left/right marks and the Arabic letter mark. A name that carries one renders in an order its
 * reader did not write, so a sender can make "Alice" draw as "Bob" — in a thread, on an approval
 * card, or inside a prompt's framing. Zero-width joiners stay: emoji and joined scripts need them.
 */
const DIRECTIONAL_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Drop directional controls so stored and displayed text keeps the order it was written in. */
export function stripDirectionalControls(value: string): string {
  return value.replace(DIRECTIONAL_CONTROLS, "");
}
