/**
 * Recognising the files OpenClaw and Hermes write when an agent is created, so an untouched
 * default is not imported as if the user wrote it (a Rakazo bot would otherwise follow
 * OpenClaw's first-run ritual, or say it is Hermes).
 *
 * A file is a default only when its whole text, with whitespace runs collapsed (and, for
 * OpenClaw, its front matter removed, as OpenClaw does when it seeds the file), is exactly
 * one published version of the template. Any added or changed line or sentence, however
 * small, makes it the user's own. Versions are kept as `<32-bit FNV-1a hex>:<UTF-8 length>`
 * of that text: every version of OpenClaw's `docs/reference/templates` files, and Hermes'
 * default SOUL.md.
 */

const versions = (text: string) => new Set(text.split(" "));

const OPENCLAW_DEFAULTS: Record<string, ReadonlySet<string>> = {
  "SOUL.md": versions(
    "1f9d4935:1656 66fe660b:231 82870d3:1786 873a4faf:1498 a5c8dc95:1549 af6fe3ed:745 " +
      "cb9241e4:1729 df5bcffe:1512 df78b67:1656 e80e4a50:584",
  ),
  "AGENTS.md": versions(
    "137b71c6:7781 1caa69dc:4199 2070d0:6398 22c4726a:1678 23f38c2a:8018 25e18af:7090 " +
      "288c9b41:7744 3354b623:3289 370c9ded:5874 4c86afec:6252 4f98b85c:6698 " +
      "65334a9:3739 6696556:7781 7064896c:6396 76cd4ca8:7777 7e087f3e:6396 " +
      "8607cdd7:7249 8e3716be:8339 95da6431:2858 962caa7d:7759 96d9010a:5160 " +
      "9a6d39a5:8622 9c52be88:6319 a6ba2dd6:7107 aa5757bc:7650 ab709141:799 " +
      "b1265948:6267 b3b00390:7786 b457dab3:7847 b8fcb34f:7126 b9642cf6:1772 " +
      "bad6ba44:7699 bc9db760:8334 befed9d5:8245 c3ecb2fe:8321 c869319:7587 " +
      "cd69aee4:6678 d25a1ade:7956 d435846:7870 e21d8010:4205 ef6cae44:3942 " +
      "ff02ccbc:979",
  ),
  "USER.md": versions(
    "2d4d6bd8:470 51eae270:470 5acbcfd1:528 9eb15e46:108 ab00c734:1125 d1a38684:860",
  ),
  "IDENTITY.md": versions(
    "1edd46fa:619 41832300:619 4cfe096f:677 6756052b:1382 6e534d55:474 7872e205:1437 " +
      "8a45e3c2:616 a1d6223f:67 cba3e7cc:1259 d556da7a:413",
  ),
};

const HERMES_SOUL_DEFAULTS: ReadonlySet<string> = versions("f1cdbf05:667");

/** True when an OpenClaw workspace file is a template OpenClaw seeded, unchanged. */
export function isOpenClawDefault(path: string, content: string): boolean {
  return OPENCLAW_DEFAULTS[path]?.has(fingerprint(withoutFrontmatter(content))) === true;
}

/** True when a Hermes SOUL.md is the default Hermes writes, unchanged. */
export function isHermesDefault(content: string): boolean {
  return HERMES_SOUL_DEFAULTS.has(fingerprint(content));
}

function withoutFrontmatter(content: string): string {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** The text with whitespace runs collapsed, as `<FNV-1a hex>:<UTF-8 length>`. */
function fingerprint(content: string): string {
  const bytes = new TextEncoder().encode(
    content
      .replace(/^\uFEFF/, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}:${bytes.length}`;
}
