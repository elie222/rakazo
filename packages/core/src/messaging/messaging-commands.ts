import { trimEndChars, trimStartChars } from "@rakazo/contracts";
/**
 * Owner text commands, parsed only in the owner's verified 1:1 conversation.
 * Everything that is not an exact command is a normal message to the bot.
 */
export type MessagingCommand = "approve" | "decline" | "leave" | "stop";

/** Unambiguous stop, abort, or halt imperatives across app languages (bare or with `/`). */
const STOP_WORDS = new Set([
  // English
  "STOP",
  "STOP NOW",
  "STOP IT",
  "STOP THIS",
  "STOP THAT",
  "STOP ALL",
  "STOP EVERYTHING",
  "PLEASE STOP",
  "STOP PLEASE",
  "ABORT",
  "HALT",
  // German
  "STOPP",
  "STOPP JETZT",
  "STOPP ES",
  // Spanish ("para" alone is too often just "for")
  "DETENTE",
  "DETENTE YA",
  // Dutch
  "STOP NU",
  "STOP ERMEE",
  // Polish (with and without diacritics)
  "ZATRZYMAJ",
  "ZATRZYMAJ TO",
  "ZATRZYMAJ WSZYSTKO",
  "ZATRZYMAJ SIĘ",
  "ZATRZYMAJ SIE",
  "PRZESTAŃ",
  "PRZESTAN",
  "PRZERWIJ",
  "PRZERWIJ TO",
  "STOP TERAZ",
  // Russian
  "СТОП",
  "ОСТАНОВИСЬ",
  "ПРЕКРАТИ",
  // Japanese
  "停止",
  "ストップ",
  "止めて",
  "中止",
  "やめて",
  // Chinese
  "停下",
  "别做了",
  // French
  "ARRÊTE",
  "ARRETE",
  "ARRÊTE ÇA",
  "ARRETE CA",
  // Portuguese
  "PARE",
  // Korean
  "멈춰",
  "중지",
  "그만",
  // Turkish
  "DUR",
  "DURDUR",
  // Hindi
  "रुको",
  "बंद करो",
  // Hebrew
  "עצור",
  "תפסיק",
  // Thai
  "หยุด",
]);

/**
 * Cancel commands recognized only with a leading `/` so ordinary replies like "cancel it"
 * to a bot's question (for example "Should I cancel the meeting?") are never swallowed.
 */
const SLASH_STOP_WORDS = new Set([
  "CANCEL",
  "CANCEL ALL",
  "ABBRECHEN",
  "CANCELAR",
  "ANNULEER",
  "ANULUJ",
  "ОТМЕНА",
  "ОТМЕНИ",
  "キャンセル",
  "取消",
  "ANNULE",
  "ANNULER",
  "취소",
  "IPTAL",
  "İPTAL",
  "रद्द करो",
  "בטל",
  "ยกเลิก",
]);

/** Cap before NFC normalization; every stop command is far shorter. */
const MAX_STOP_PHRASE_LENGTH = 64;

/**
 * Linear-time normalization for stop commands: strips leading ¡¿, one optional leading
 * slash command prefix, and trailing sentence punctuation, and collapses internal whitespace
 * and at most one comma separator between words (e.g. "stop, now", "please, stop").
 */
function normalizeStopPhrase(text: string): { phrase: string; slash: boolean } | null {
  const stripped = trimEndChars(trimStartChars(text.trim(), "¡¿"), ".!?…。！？।").trim();
  if (!stripped) return null;
  let source = stripped;
  let slash = false;
  if (source.startsWith("/")) {
    slash = true;
    source = source.slice(1);
    if (!source || /\s/.test(source[0]!)) return null;
  }
  let out = "";
  let inSpace = false;
  let commas = 0;
  let afterComma = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === ",") {
      if (out.length === 0 || commas > 0) return null;
      commas = 1;
      inSpace = true;
      afterComma = true;
    } else if (/\s/.test(ch)) {
      if (out.length > 0) inSpace = true;
    } else {
      if (inSpace) {
        out += " ";
        inSpace = false;
      }
      out += ch;
      afterComma = false;
      if (out.length > MAX_STOP_PHRASE_LENGTH) return null;
    }
  }
  if (!out || afterComma) return null;
  return { phrase: out.normalize("NFC").toUpperCase(), slash };
}

export function parseMessagingCommand(text: string): MessagingCommand | null {
  const normalized = text.trim().toUpperCase();
  if (normalized === "YES") return "approve";
  if (normalized === "NO") return "decline";
  if (normalized === "LEAVE") return "leave";
  const parsed = normalizeStopPhrase(text);
  if (
    parsed &&
    (STOP_WORDS.has(parsed.phrase) || (parsed.slash && SLASH_STOP_WORDS.has(parsed.phrase)))
  ) {
    return "stop";
  }
  return null;
}
