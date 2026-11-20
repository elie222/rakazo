/**
 * How full a memory document is, in tokens: one per CJK character, one per four other
 * characters, rounded up. Counting each CJK character as a full token keeps Chinese notes
 * from being judged four times larger than they read.
 */
export function memoryTokenCount(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** Korean, Japanese kana, Han and the full-width forms read as one token per character. */
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/u;
