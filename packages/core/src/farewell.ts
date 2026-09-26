/** Lead-ins and tails that may wrap a closing phrase without changing what it means. */
const FILLER = [
  "thank you",
  "for today",
  "for now",
  "alright",
  "perfect",
  "thanks",
  "great",
  "okay",
  "cool",
  "bye",
  "ok",
];

const CLOSING = [
  "that'll be all",
  "that will be all",
  "that's all for now",
  "that's everything",
  "that's all",
  "that's it",
  "talk to you later",
  "catch you later",
  "talk later",
  "goodbye",
  "good bye",
  "see you",
  "see ya",
  "end the call",
  "end call",
  "hang up",
  "i'm done",
  "we're done",
  "nothing else",
  "bye",
];

const filler = FILLER.join("|");
// Whole-utterance only: a closing phrase alone, give or take filler on either side.
const FAREWELL = new RegExp(`^(?:(?:${filler}) )*(?:${CLOSING.join("|")})(?: (?:${filler}))*$`);
const MAX_WORDS = 8;

/** True when the whole utterance is the caller saying goodbye, not a sentence mentioning one. */
export function isFarewell(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > MAX_WORDS) return false;
  return FAREWELL.test(words.join(" "));
}
