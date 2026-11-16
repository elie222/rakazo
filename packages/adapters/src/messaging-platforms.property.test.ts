import { TelegramFormatConverter } from "@chat-adapter/telegram";
import { WhatsAppAdapter } from "@chat-adapter/whatsapp";
import { ConsoleLogger, convertEmojiPlaceholders, markdownToPlainText } from "chat";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { splitOutboundBody, telegramFallbackText } from "./messaging-platforms.js";

const LIMIT = 4096;

class WhatsAppRenderer extends WhatsAppAdapter {
  render(markdown: string): string {
    return convertEmojiPlaceholders(this.formatConverter.renderPostable({ markdown }), "whatsapp");
  }
}

const telegram = new TelegramFormatConverter();
const whatsapp = new WhatsAppRenderer({
  accessToken: "",
  appSecret: "",
  logger: new ConsoleLogger("silent"),
  phoneNumberId: "",
  userName: "",
  verifyToken: "",
});

type Provider = "telegram" | "whatsapp";
/** A reply, the text a person should see for it outside code blocks, and its code. */
type Reply = { body: string; text: string; code: string[] };
type Delivery = { part: string; sent: string; fallback: string; text: string; code: string[] };

function sentText(provider: Provider, part: string): string {
  return provider === "telegram"
    ? convertEmojiPlaceholders(telegram.fromMarkdown(part), "gchat")
    : whatsapp.render(part);
}

const FENCED = /```[^\n]*\n([\s\S]*?)\n```/g;
const TELEGRAM_LINK = /\[((?:\\.|[^\]\\])*)\]\((?:\\.|[^)\\])*\)/g;
const WHATSAPP_LINK = /<(https?:[^>\s]+)>/g;

/** A sent message's text without its code blocks, link addresses and quote bars, escapes kept. */
function markup(provider: Provider, sent: string): string {
  const prose = sent.replace(FENCED, "\n").replace(/^> ?/gm, "");
  return provider === "telegram"
    ? prose.replace(TELEGRAM_LINK, "$1")
    : prose.replace(WHATSAPP_LINK, (_, url: string) => url.replace(/[*_~]/g, "\\$&"));
}

/** What a person sees of a sent message: its text once the platform renders it, and its code. */
function view(provider: Provider, sent: string): { text: string; code: string[] } {
  const code = [...sent.matchAll(FENCED)].map(([, block = ""]) =>
    provider === "telegram" ? block.replace(/\\([`\\])/g, "$1") : block,
  );
  const text = markup(provider, sent)
    .replace(/(?<!\\)[*_~`]/g, "")
    .replace(/\\(.)/g, "$1");
  return { text, code };
}

// Splitting renders Markdown several times per reply, so the properties share each result.
const deliveries = new Map<string, Delivery[]>();

function deliver(provider: Provider, body: string): Delivery[] {
  const key = `${provider}\n${body}`;
  let delivery = deliveries.get(key);
  if (!delivery) {
    delivery = splitOutboundBody(provider, body).map((part) => {
      const sent = sentText(provider, part);
      const fallback =
        provider === "telegram"
          ? convertEmojiPlaceholders(telegramFallbackText(part), "gchat")
          : "";
      return { part, sent, fallback, ...view(provider, sent) };
    });
    deliveries.set(key, delivery);
  }
  return delivery;
}

function textLeftAfter(text: string, slices: string[]): string | undefined {
  let rest = text.trimStart();
  for (const slice of slices) {
    const wanted = slice.trim();
    if (!rest.startsWith(wanted)) return undefined;
    rest = rest.slice(wanted.length).trimStart();
  }
  return rest;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const characters = (text: string) =>
  [...segmenter.segment(text)].map(({ segment }) => segment).filter((segment) => segment.trim());

const chars = (alphabet: string, minLength: number, maxLength: number) =>
  fc.string({ unit: fc.constantFrom(...alphabet), minLength, maxLength });

const upTo = <T>(item: fc.Arbitrary<T>, max: number) =>
  fc
    .tuple(
      fc.array(item, { minLength: max, maxLength: max }),
      fc.noBias(fc.integer({ min: 1, max })),
    )
    .map(([items, count]) => items.slice(0, count));

const run = (unit: string, max: number) =>
  fc.noBias(fc.integer({ min: 2, max })).map((length) => unit.repeat(length));

const gap = fc.constantFrom(" ", " ", " ", " ", "\n", "\n\n");
const spaced = (tokens: fc.Arbitrary<string[]>, between: fc.Arbitrary<string> = gap) =>
  fc
    .tuple(tokens, fc.array(between, { minLength: 400, maxLength: 400 }))
    .map(([items, gaps]) =>
      items.map((item, index) => (index ? gaps[index % gaps.length]! : "") + item).join(""),
    );

const word = fc.oneof(
  { weight: 8, arbitrary: chars("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZéüñ", 1, 12) },
  { weight: 1, arbitrary: fc.constantFrom("😀", "🚀", "☀", "👍", "🇫🇷", "👍🏽", "👨‍👩‍👧‍👦") },
);
const sentenceEnd = fc.constantFrom("", "", "", ".", "!", ",", "?");
const prose = spaced(
  upTo(
    fc.tuple(word, sentenceEnd).map((parts) => parts.join("")),
    400,
  ),
);
const unbroken = fc
  .tuple(
    fc.constantFrom("a", "é", "😀", "!", "x😀", "🇫🇷", "👍🏽", "👨‍👩‍👧‍👦"),
    fc.noBias(fc.integer({ min: 1, max: 4500 })),
  )
  .map(([unit, length]) => unit.repeat(Math.ceil(length / unit.length)));
const segment = fc.oneof(prose, unbroken);
/** Plain text: prose and unbroken runs, read the same with or without Markdown. */
const plainReply: fc.Arbitrary<Reply> = spaced(fc.tuple(segment, segment, segment)).map((body) => ({
  body,
  text: body,
  code: [],
}));

type Piece = { markdown: string; text: string; code?: string };

const words = (max: number) => upTo(word, max).map((items) => items.join(" "));
const styled = (open: string, close: string, max: number) =>
  words(max).map((text): Piece => ({ markdown: `${open}${text}${close}`, text }));
const literal = (...values: string[]) =>
  fc.constantFrom(...values).map((text): Piece => ({ markdown: text, text }));

const inline = fc.oneof(
  { weight: 12, arbitrary: styled("", "", 12) },
  { weight: 2, arbitrary: styled("**", "**", 30) },
  { weight: 2, arbitrary: styled("*", "*", 30) },
  { weight: 1, arbitrary: styled("~~", "~~", 8) },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom("&amp;", "&lt;div&gt;", "a[0]", "f(x)", "#1!")
      .map((text): Piece => ({ markdown: `\`${text}\``, text })),
  },
  {
    weight: 2,
    arbitrary: literal("https://example.com/a_b?x=1", "https://example.org/docs/page.html#top"),
  },
);
const inlineGap = fc.oneof(
  { weight: 30, arbitrary: fc.constantFrom(" ", "\n") },
  { weight: 1, arbitrary: run(" ", 3000) },
);
const join = (pieces: fc.Arbitrary<Piece[]>, between: fc.Arbitrary<string>) =>
  fc.tuple(pieces, fc.array(between, { minLength: 40, maxLength: 40 })).map(
    ([items, gaps]): Piece => ({
      markdown: items
        .map((item, index) => (index ? gaps[index % gaps.length]! : "") + item.markdown)
        .join(""),
      text: items.map((item) => item.text).join(" "),
    }),
  );
// A line of text opens each run of rows, as in a real reply; it also keeps two lists apart.
const lines = (prefix: (index: number) => string, max: number) =>
  upTo(words(12), max).map((items): Piece => {
    const rows = ["Next:", ...items.map((item, index) => `${prefix(index)}${item}`)].join("\n");
    return { markdown: rows, text: rows.replace(/^> /gm, "") };
  });

const codeLine = fc
  .tuple(
    fc.constantFrom("", "  ", "    ", "        ", "\t"),
    fc.constantFrom(
      "def f(a, b):",
      "return a * b + __init__[0] # done!",
      'x = "\\n" + y[1] * 2  # a `tick` and a \\ slash',
      "if a < b && c > d: print(&amp;, <div>)",
      "- not a list",
      "1. not a list",
      "# not a heading",
      "> not a quote",
      "**not bold** and _not italic_ and [not](a link)",
      "https://example.com/a_b?x=1",
      "",
    ),
  )
  .map((parts) => parts.join(""));
const blankLines = fc.oneof(
  { weight: 3, arbitrary: fc.constant<string[]>([]) },
  { weight: 1, arbitrary: run("\n", 2000).map((gapLines) => gapLines.slice(1).split("\n")) },
);
const fenced = (max: number) =>
  fc
    .tuple(
      fc.constantFrom("", "python", "text"),
      upTo(codeLine, max),
      blankLines,
      upTo(codeLine, max),
    )
    .map(([lang, before, blank, after]): Piece => {
      const code = ["start()", ...before, ...blank, ...after, "end()"].join("\n");
      return { markdown: `\`\`\`${lang}\n${code}\n\`\`\``, text: "", code };
    });

const block = fc.oneof(
  { weight: 6, arbitrary: join(upTo(inline, 80), inlineGap) },
  { weight: 2, arbitrary: styled("## ", "", 6) },
  { weight: 2, arbitrary: lines((index) => `${index + 1}. `, 60) },
  { weight: 2, arbitrary: lines(() => "- ", 60) },
  { weight: 2, arbitrary: lines(() => "> ", 20) },
  { weight: 3, arbitrary: fenced(20) },
  // Too long for one message, so a cut has to land inside the formatting.
  { weight: 1, arbitrary: fenced(150) },
  { weight: 1, arbitrary: styled("**", "**", 900) },
  { weight: 1, arbitrary: lines((index) => `${index + 1}. `, 400) },
  { weight: 1, arbitrary: lines(() => "> ", 300) },
);
const blockGap = fc.oneof(
  { weight: 12, arbitrary: fc.constant("\n\n") },
  { weight: 1, arbitrary: run("\n", 3000) },
);
/** Formatted replies: code, lists, quotes, links and styled text, around long runs of white space. */
const formattedReply: fc.Arbitrary<Reply> = fc
  .tuple(
    fc.array(block, { minLength: 2, maxLength: 9 }),
    fc.array(blockGap, { minLength: 9, maxLength: 9 }),
    fc.constantFrom("", "\n", "  \n"),
  )
  .map(([blocks, gaps, end]) => ({
    body: blocks.map((piece, index) => (index ? gaps[index]! : "") + piece.markdown).join("") + end,
    text: blocks.map((piece) => piece.text).join("\n"),
    code: blocks.flatMap((piece) => piece.code ?? []),
  }));

const DOCS = "https://example.com/docs/start";
const SITE = "https://example.org/a_b?x=1";
const CHART = "https://example.com/chart.png";
const DEFINITIONS = `[docs]: ${DOCS} "The docs"\n[site]: ${SITE}\n[chart]: <${CHART}>`;
const FOOTNOTE = "[^1]: Where the claim comes from.";

/** A link, image or footnote marker: how it is written, what plain text shows, its address. */
type Linked = { markdown: string; text: string; address?: string };
const labelled = (write: (label: string) => string, address: string) =>
  words(4).map((label): Linked => ({ markdown: write(label), text: label, address }));
const linked: fc.Arbitrary<Linked> = fc.oneof(
  { weight: 8, arbitrary: words(12).map((text): Linked => ({ markdown: text, text })) },
  { weight: 2, arbitrary: labelled((label) => `[${label}](${DOCS})`, DOCS) },
  { weight: 2, arbitrary: labelled((label) => `[${label}][docs]`, DOCS) },
  { weight: 2, arbitrary: labelled((label) => `[**${label}**][DOCS]`, DOCS) },
  { weight: 1, arbitrary: labelled((label) => `![${label}][chart]`, CHART) },
  {
    weight: 1,
    arbitrary: fc.constant<Linked>({ markdown: "[site]", text: "site", address: SITE }),
  },
  { weight: 1, arbitrary: fc.constant<Linked>({ markdown: "a claim[^1]", text: "a claim[^1]" }) },
);
// Longer than one message, so no part can hold it as a link.
const oversized = fc
  .tuple(fc.constantFrom("0", "😀", "👍🏽"), fc.noBias(fc.integer({ min: 4097, max: 6000 })))
  .map(([unit, length]): Linked => {
    const markdown = `[here](https://example.com/${unit.repeat(Math.ceil(length / unit.length))})`;
    return { markdown, text: markdown };
  });
const linkedBlock = fc
  .tuple(
    fc.constantFrom("", "", "", "## ", "- ", "> "),
    upTo(fc.oneof({ weight: 100, arbitrary: linked }, { weight: 1, arbitrary: oversized }), 30),
  )
  .map(([prefix, items]) => ({
    markdown: prefix + items.map((item) => item.markdown).join(" "),
    text: items.map((item) => item.text).join(" "),
    addresses: items.flatMap((item) => item.address ?? []),
  }));
const linkedBlocks = (min: number, max: number) =>
  fc.array(linkedBlock, { minLength: min, maxLength: max }).map((blocks) => ({
    // The definitions sit at the end, away from most of the references that need them.
    body: [...blocks.map((block) => block.markdown), DEFINITIONS, FOOTNOTE].join("\n\n"),
    text: [...blocks.map((block) => block.text), FOOTNOTE].join("\n"),
    addresses: blocks.flatMap((block) => block.addresses),
  }));
/** Replies with labelled links, reference-style links and images, footnotes and long addresses. */
const linkedReply = linkedBlocks(6, 10).filter(({ body }) => body.length > LIMIT);
const shortLinkedReply = linkedBlocks(1, 3).filter(({ body }) => body.length < 1500);

const count = (text: string, wanted: string) => text.split(wanted).length - 1;

const reply = fc.oneof(plainReply, formattedReply);
// A failure is reported as found: shrinking splits thousands more replies and cannot be timed out.
const runs = { seed: 42, numRuns: 10, endOnFailure: true };

describe.each<Provider>(["telegram", "whatsapp"])(
  "splitOutboundBody properties for %s",
  (provider) => {
    it("keeps every part within the limit, both as queued and as sent", () => {
      fc.assert(
        fc.property(reply, ({ body }) => {
          for (const { part, sent, fallback } of deliver(provider, body)) {
            expect(part.length).toBeLessThanOrEqual(LIMIT);
            expect(sent.length).toBeLessThanOrEqual(LIMIT);
            expect(fallback.length).toBeLessThanOrEqual(LIMIT);
          }
        }),
        runs,
      );
    });

    it("returns a reply that fits one message as it was written", () => {
      fc.assert(
        fc.property(shortLinkedReply, ({ body }) => {
          expect(splitOutboundBody(provider, body)).toEqual([body]);
        }),
        runs,
      );
    });

    it("delivers a reply with links, references and footnotes once and in order", () => {
      fc.assert(
        fc.property(linkedReply, ({ body, text }) => {
          const delivery = deliver(provider, body);
          expect(delivery.length).toBeGreaterThan(1);
          for (const { part, sent, fallback } of delivery) {
            for (const queued of [part, sent, fallback]) {
              expect(queued.length).toBeLessThanOrEqual(LIMIT);
              expect(/[\uD800-\uDFFF]/u.test(queued)).toBe(false);
            }
            expect(markdownToPlainText(part).trim()).not.toBe("");
          }
          // Each part's own plain text: a label for a link, and the written text for a footnote
          // or for an address too long to send as a link.
          const shown = delivery.map(({ part }) => markdownToPlainText(part));
          expect(shown.join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
        }),
        runs,
      );
    });

    it("gives every link its address in the part that shows it", () => {
      fc.assert(
        fc.property(linkedReply, ({ body, addresses }) => {
          const delivery = deliver(provider, body);
          for (const { part } of delivery) {
            // No reference is left for a definition in another part, and no definition is sent.
            expect(part).not.toMatch(/\]\[|^\[(?:docs|site|chart)\]:/m);
          }
          for (const address of [DOCS, SITE, CHART]) {
            const written = addresses.filter((each) => each === address).length;
            expect(count(delivery.map(({ sent }) => sent).join("\n"), address)).toBe(written);
            if (provider === "telegram") {
              const fallback = delivery.map((part) => part.fallback).join("\n");
              expect(count(fallback, `(${address})`)).toBe(written);
            }
          }
        }),
        runs,
      );
    });

    it("sends no blank part and never half a character", () => {
      fc.assert(
        fc.property(reply, ({ body, text }) => {
          const delivery = deliver(provider, body);
          for (const { part, sent, text: shown, code } of delivery) {
            expect(`${shown}${code.join("")}`.trim()).not.toBe("");
            expect(/[\uD800-\uDFFF]/u.test(part)).toBe(false);
            expect(/[\uD800-\uDFFF]/u.test(sent)).toBe(false);
          }
          // A flag or a joined emoji cut in two shows as two characters.
          expect(delivery.flatMap((part) => characters(part.text))).toEqual(characters(text));
        }),
        runs,
      );
    });

    it("delivers the reply's visible text once and in order", () => {
      fc.assert(
        fc.property(reply, ({ body, text }) => {
          const shown = deliver(provider, body).map((part) => part.text);
          expect(shown.join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
        }),
        runs,
      );
    });

    it("drops only white space where it cuts plain text", () => {
      fc.assert(
        fc.property(plainReply, ({ body }) => {
          const shown = deliver(provider, body).map((part) => part.text);
          expect(textLeftAfter(body, shown)).toBe("");
        }),
        runs,
      );
    });

    it("delivers code exactly as written", () => {
      fc.assert(
        fc.property(formattedReply, ({ body, code }) => {
          const shown = deliver(provider, body).flatMap((part) => part.code);
          expect(shown.join("\n")).toBe(code.join("\n"));
        }),
        runs,
      );
    });

    it("sends parts that each render on their own", () => {
      fc.assert(
        fc.property(formattedReply, ({ body }) => {
          for (const { sent } of deliver(provider, body)) {
            // Every code block a part opens it also closes.
            expect(sent.split("```").length % 2).toBe(1);
            const styling = markup(provider, sent)
              .replace(/`[^`\n]*`/g, "")
              .replace(/\\./g, "");
            // Bold, italic and struck text end in the part they start in, and none shows as "**".
            for (const marker of "*_~`") expect(styling.split(marker).length % 2).toBe(1);
            expect(styling).not.toMatch(/\*\*|~~/);
            // A link is whole: Telegram escapes every bracket that is not part of one.
            if (provider === "telegram") expect(styling).not.toMatch(/[[\]()]/);
          }
        }),
        runs,
      );
    });
  },
);
