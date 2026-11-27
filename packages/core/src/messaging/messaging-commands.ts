import { trimEndChars, trimStartChars } from "@rakazo/contracts";
/**
 * Owner text commands, parsed only in the owner's verified 1:1 conversation.
 * Everything that is not an exact command is a normal message to the bot.
 */
export type MessagingCommand = "approve" | "decline" | "leave" | "stop";

/** Unambiguous stop or cancel imperatives across app languages. */
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
  "CANCEL",
  "CANCEL IT",
  "CANCEL THIS",
  "CANCEL THAT",
  "CANCEL ALL",
  "ABORT",
  "HALT",
  // German
  "STOPP",
  "STOPP JETZT",
  "STOPP ES",
  "ABBRECHEN",
  // Spanish ("para" alone is too often just "for")
  "DETENTE",
  "DETENTE YA",
  "CANCELAR",
  // Dutch
  "STOP NU",
  "STOP ERMEE",
  "ANNULEER",
  // Polish (with and without diacritics)
  "ZATRZYMAJ",
  "ZATRZYMAJ TO",
  "ZATRZYMAJ WSZYSTKO",
  "ZATRZYMAJ SIĘ",
  "ZATRZYMAJ SIE",
  "PRZESTAŃ",
  "PRZESTAN",
  "ANULUJ",
  "ANULUJ TO",
  "PRZERWIJ",
  "PRZERWIJ TO",
  "STOP TERAZ",
  // Russian
  "СТОП",
  "ОСТАНОВИСЬ",
  "ОТМЕНА",
  "ОТМЕНИ",
  "ПРЕКРАТИ",
  // Japanese
  "停止",
  "ストップ",
  "止めて",
  "キャンセル",
  "中止",
  "やめて",
  // Chinese
  "停下",
  "取消",
  "别做了",
  // French
  "ARRÊTE",
  "ARRETE",
  "ARRÊTE ÇA",
  "ARRETE CA",
  "ANNULE",
  "ANNULER",
  // Portuguese ("cancelar" is listed above)
  "PARE",
  // Korean
  "멈춰",
  "중지",
  "취소",
  "그만",
  // Turkish (include dotted capital İ alongside ASCII I)
  "DUR",
  "DURDUR",
  "IPTAL",
  "İPTAL",
  // Hindi
  "रुको",
  "रद्द करो",
  "बंद करो",
  // Hebrew
  "עצור",
  "תפסיק",
  "בטל",
  // Thai
  "หยุด",
  "ยกเลิก",
]);

/** Cap before NFC normalization; every stop command is far shorter. */
const MAX_STOP_PHRASE_LENGTH = 64;

/**
 * Linear-time normalization for bare stop commands: strips leading ¡¿, one optional leading
 * slash command prefix, and trailing sentence punctuation, and collapses internal whitespace
 * and at most one comma separator between words (e.g. "stop, now", "please, stop").
 */
function normalizeStopPhrase(text: string): string {
  const stripped = trimEndChars(trimStartChars(text.trim(), "¡¿"), ".!?…。！？।").trim();
  if (!stripped) return "";
  let source = stripped;
  if (source.startsWith("/")) {
    source = source.slice(1);
    if (!source || /\s/.test(source[0]!)) return "";
  }
  let out = "";
  let inSpace = false;
  let commas = 0;
  let afterComma = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === ",") {
      if (out.length === 0 || commas > 0) return "";
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
      if (out.length > MAX_STOP_PHRASE_LENGTH) return "";
    }
  }
  if (!out || afterComma) return "";
  return out.normalize("NFC").toUpperCase();
}

export function parseMessagingCommand(text: string): MessagingCommand | null {
  const normalized = text.trim().toUpperCase();
  if (normalized === "YES") return "approve";
  if (normalized === "NO") return "decline";
  if (normalized === "LEAVE") return "leave";
  if (STOP_WORDS.has(normalizeStopPhrase(text))) return "stop";
  return null;
}
