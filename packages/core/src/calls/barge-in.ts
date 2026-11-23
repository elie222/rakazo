import { spokenMemory } from "./echo.js";
import { speechWordCount } from "./speech-words.js";

/** Lower echo match while audio plays: most of what the mic hears is the speaker. */
const PLAYBACK_ECHO_RATIO = 0.4;
/** The only one-word turns worth cutting a reply short for. */
const INTERRUPT_WORDS = new Set([
  "stop",
  "wait",
  "hold on",
  "pause",
  "no",
  "停",
  "不",
  "不是",
  "不要",
  "不对",
  "いいえ",
  "ไม่",
  "等一下",
  "等等",
  "待って",
  "หยุด",
]);
/** Short acknowledgements in scripts written without spaces; never a reason to cut a reply short. */
const BACKCHANNELS = new Set([
  "嗯",
  "嗯嗯",
  "哦",
  "啊",
  "对",
  "对对",
  "好",
  "好的",
  "好吧",
  "是的",
  "是啊",
  "對",
  "はい",
  "うん",
  "ええ",
  "ああ",
  "なるほど",
  "そうですね",
  "そうですか",
  "ครับ",
  "ค่ะ",
  "ใช่",
  "โอเค",
]);

/**
 * How long an interim phrase must stand before it cuts playback.
 * The final transcript arrives later, after the reply has already finished.
 */
export const INTERIM_BARGE_IN_MS = 300;

/** A sentence, or one interruption word, that is not the reply leaking back into the mic. */
export function isCallBargeIn(text: string): boolean {
  if (spokenMemory.isEcho(text, PLAYBACK_ECHO_RATIO)) return false;
  const cleaned = cleanWords(text);
  return isSentence(cleaned) || INTERRUPT_WORDS.has(cleaned);
}

/** An interim is revised word by word, so one stray word never cuts playback. */
export function isInterimCallBargeIn(text: string): boolean {
  return isSentence(cleanWords(text)) && !spokenMemory.isEcho(text, PLAYBACK_ECHO_RATIO);
}

function isSentence(cleaned: string): boolean {
  return speechWordCount(cleaned) >= 2 && !BACKCHANNELS.has(cleaned.replace(/ /g, ""));
}

function cleanWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Counts down an interim phrase heard over a reply: one that stands for
 * INTERIM_BARGE_IN_MS calls `onBargeIn`, and anything that no longer qualifies resets it.
 */
export function createInterimBargeIn(onBargeIn: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    hear(text: string): void {
      if (!isInterimCallBargeIn(text)) {
        clear();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        onBargeIn();
      }, INTERIM_BARGE_IN_MS);
    },
    clear,
  };
}
