/**
 * Recognising the files OpenClaw and Hermes write when an agent is created, so an untouched
 * default is not imported as if the user wrote it (a Rakazo bot would otherwise follow
 * OpenClaw's first-run ritual, or say it is Hermes).
 *
 * A file is a default when it has its template's title (or, for Hermes, its opening line)
 * and its content units (lines, or Hermes' sentences) all come from a known version of the
 * template, allowing one changed unit for small differences between versions. Known units
 * are kept as 32-bit FNV-1a hashes of the whitespace-collapsed text: every line of every
 * published version of OpenClaw's `docs/reference/templates` files, and the sentences of
 * Hermes' default SOUL.md. USER.md and IDENTITY.md allow no changed line, since any added
 * line there is something the user said about themselves.
 */

type Template = { titles: readonly string[]; units: ReadonlySet<string>; tolerance: number };

const hashes = (text: string) => new Set(text.split(" "));

const OPENCLAW_TEMPLATES: Record<string, Template> = {
  "SOUL.md": {
    titles: ["# SOUL.md - Who You Are"],
    units: hashes(
      "202e0443 223b9d4e 226e86e5 2f9acc92 4149234 431a6162 45d30ca0 4a544fd8 5f20c72a 618e811b " +
        "6cfddca3 6d5f3dc2 7013946a 75bc4da6 7c9d58ae 802fc61c 8627285d 8e5fcf07 8f662df0 918d20d " +
        "98664f6d 9d8ec20d b01524ea b1a8d012 b57a0efa be9179c1 bfdd4f6e c4e4dc86 c67d6a35 " +
        "d28faf3f d5dc7cc df62f226 e59c166a e6923d08 ea34d edd97e61 f55e3fe0 f81cf691",
    ),
    tolerance: 1,
  },
  "AGENTS.md": {
    titles: ["# AGENTS.md - Your Workspace"],
    units: hashes(
      "1045d3b 1050411f 1137534f 124bb22c 1306a567 14cbae81 1538e432 159a2714 1777a10b 18be6848 " +
        "19153e8d 1a268350 1a37c3be 1a62ff15 1a642c60 1b8fd16f 1c2513e2 1c5234a8 1c828ca0 " +
        "1d620171 1d89c74c 1deb0b9b 1e7fc5e6 1fd17e35 209bfaeb 209d7a8d 20a962c4 221cc6c7 " +
        "22773676 22c27c94 22e0c74f 23320428 240dcc49 2480a694 2519dff5 26bcbfc1 299d248b " +
        "29d44005 2ae6b987 2ca8a78e 2d321b4e 2f21d3e2 2f8c612d 305f81b4 30cfbec 310d2782 32b28cbb " +
        "33d4bd17 345f29e4 34ee8cbc 39535a1f 39762d32 3ad4475c 3b2f2bee 3b9e2039 3ba42fc7 " +
        "3bb54c05 3bb56fc3 3d6b3fbf 3d865ad0 3ed9c8d2 3fc815d5 40724b6 40ffc5b4 428bc90f 433eeaf3 " +
        "443cf294 445150b 44bf4ad8 45e6526c 4837c03d 48c38c13 49924b5c 4afcdcb4 4b6b7c4e 4b794c64 " +
        "4bec736c 4c78b3e4 4d70a0a6 4ea7f7d5 4ec57369 4f18ef18 4f8aae3e 4fbb35de 4ff4efc7 " +
        "512f7e94 519b4e77 528730b4 52ecd912 536c2fa5 552de628 55ce1af6 55e4744c 5636e2ad " +
        "584427f6 5add610d 5bc56cc5 5d9118b4 5e1d6dea 5ebf916 5edc0a23 5fe5cbc4 614a5d5e 62717ad8 " +
        "63042e29 6383fef6 64fda829 65a68647 6652adec 67a98c2d 6819ea5e 690e9bfd 6949366b 69f87b " +
        "6a9d865c 6ac19b90 6af6f5a2 6b5eaaa6 6bc30537 6e723960 700a0ae1 70526a9b 70f0c3de " +
        "715b65e8 71e1229e 723ae6b9 7286be1 72ba5c6d 73b71a1e 7577cbbf 75fe8d4e 761640dc 761d6263 " +
        "76db44c5 798c6c4c 79a670f6 7a7bb93e 7ac3b515 7af8c372 7d8c68fd 7e6f702 7e823078 802fc61c " +
        "80588ec8 80e84d87 81b83fe 81e388ae 81fb0c9b 823d5e95 82e942cd 845d8747 860ab153 87531520 " +
        "885e465b 88da37f4 89fc87b2 8a5c05c7 8b06caf9 8ce9a3a4 8d7361b0 8dcc6690 8e2a7297 " +
        "8e4d87b1 90a2de9e 92f04d16 937aa6e0 955f155e 9606d633 96850f2e 970f102d 9775c51 99380ab4 " +
        "99591d25 9b24093b 9b875043 9c2537fa 9df355b 9eae71e3 9fbb2c53 9fc98c31 a148e7ec a1ba758d " +
        "a25653cc a317f8a7 a338ac72 a35247c5 a540e200 a67a8e31 a6c0ef91 a712704f a86af62 aacad6b4 " +
        "ab8f2835 ac30cf8d ac5f16d3 ad1242ab ad2ac7da ad861d45 ae63c5db ae9143e3 af06fa3a " +
        "af1994c5 b02e76f0 b0427473 b09b5e08 b21a3311 b2a3c167 b2ed2b85 b4aba6db b5380564 " +
        "b6566766 b6769cac b7288fe0 b93e0073 b99b94a6 b9e25dcc bb9c470e bc594f1d bcd6ebc4 " +
        "bd1d3ccf bd536de3 bdf030ea bf6ff300 bfbba2e4 bfbbf538 c0e8adc0 c3a1879b c60e6aeb " +
        "c61e30d2 c6dd444a c7f34e15 c8d371b9 c90a5a7c c99d8da ca9e334e cb8654ce cd4083db d04b3ff0 " +
        "d08eed65 d125ec14 d21e422d d29cce28 d314c6e5 d3cdc2f4 d5f8f824 d66283d d6636c89 d6d5b897 " +
        "d9b26f8d da8bc57 daf52567 dcf745b8 dd7712dc dde4c7d4 de05b011 e029b873 e0742689 e26f22f8 " +
        "e3b94f0e e4489dd5 e54294da e5b76a1a e64db689 e69df143 eb2c378c ec70d4eb ec87faf9 " +
        "edbb6511 eee0a26b ef1d1276 f02cf71d f085c0db f0cb1f0f f1fcdb1d f28320c4 f2ac2f2f " +
        "f4214c3f f468dc92 f53756e f629a93f f6494efe f80c48a8 f9a868a6 fa09aa85 fa52f22f fa61b791 " +
        "fa7e3d8e faa532dc fb4c2793 fc657a3 fc9bc88f fe0c521a fe997491 feb15e15 feca932a",
    ),
    tolerance: 1,
  },
  "USER.md": {
    titles: ["# USER.md - User Model", "# USER.md - About Your Human"],
    units: hashes(
      "153ca637 1d2c5b3b 270fb585 2966ab20 2cea8067 31782745 401a3ca0 45ff6ccf 53132b78 " +
        "55d776a6 5b2259fb 5e8e23f 6017cd80 64438e06 660614a6 6e73687f 802fc61c 85ec8573 8e2a7297 " +
        "a663dc74 b5bc3177 c41a5359 c4e4dc86 d7effa0 e828dd5e eb29be3a ebc112ec ed46ec8a edd4c3f8 " +
        "face25d4 fb03e1f9",
    ),
    tolerance: 0,
  },
};

const HERMES_SOUL: Template = {
  titles: ["You are Hermes Agent"],
  units: hashes("424a73af 6f594437 8725ab99 c298aee6 da64cb13 f2e47de6"),
  tolerance: 1,
};

/** True when an OpenClaw workspace file is the template OpenClaw seeded, unchanged. */
export function isOpenClawDefault(path: string, content: string): boolean {
  const template = OPENCLAW_TEMPLATES[path];
  if (!template) return false;
  const lines = withoutFrontmatter(content).split("\n").map(collapse).filter(Boolean);
  if (!template.titles.includes(lines[0] ?? "")) return false;
  return isKnown(lines, template);
}

/** True when a Hermes SOUL.md is the default Hermes writes. */
export function isHermesDefault(content: string): boolean {
  const text = collapse(content);
  if (!HERMES_SOUL.titles.some((title) => text.startsWith(title))) return false;
  return isKnown(
    text
      .split(/(?<=[.!?])\s+/)
      .map(collapse)
      .filter(Boolean),
    HERMES_SOUL,
  );
}

function isKnown(units: string[], template: Template): boolean {
  const unknown = units.filter((unit) => !template.units.has(fnv1a(unit))).length;
  return unknown <= template.tolerance;
}

function withoutFrontmatter(content: string): string {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 32-bit FNV-1a of the text's UTF-8 bytes, in hexadecimal. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}
