import { TelegramFormatConverter } from "@chat-adapter/telegram";
import { WhatsAppAdapter } from "@chat-adapter/whatsapp";
import { ConsoleLogger, convertEmojiPlaceholders } from "chat";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { splitOutboundBody } from "./messaging-platforms.js";

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
type Delivery = { part: string; sent: string; visible: string };

function sentText(provider: Provider, part: string): string {
  return provider === "telegram"
    ? convertEmojiPlaceholders(telegram.fromMarkdown(part), "gchat")
    : whatsapp.render(part);
}

function visibleText(provider: Provider, sent: string): string {
  const unfenced = sent
    .split("\n")
    .filter((line) => !line.startsWith("```"))
    .join("\n");
  return provider === "telegram" ? unfenced.replace(/\\(.)/g, "$1") : unfenced;
}

// Splitting renders Markdown several times per reply, so the properties share each result.
const deliveries = new Map<string, Delivery[]>();

function deliver(provider: Provider, body: string): Delivery[] {
  const key = `${provider}\n${body}`;
  let delivery = deliveries.get(key);
  if (!delivery) {
    delivery = splitOutboundBody(provider, body).map((part) => {
      const sent = sentText(provider, part);
      return { part, sent, visible: visibleText(provider, sent) };
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

const words = (text: string) => text.split(/\s+/).filter(Boolean);

const chars = (alphabet: string, minLength: number, maxLength: number) =>
  fc.string({ unit: fc.constantFrom(...alphabet), minLength, maxLength });

const upTo = <T>(item: fc.Arbitrary<T>, max: number) =>
  fc
    .tuple(
      fc.array(item, { minLength: max, maxLength: max }),
      fc.noBias(fc.integer({ min: 1, max })),
    )
    .map(([items, count]) => items.slice(0, count));

const gap = fc.constantFrom(" ", " ", " ", " ", "\n", "\n\n");
const spaced = (tokens: fc.Arbitrary<string[]>) =>
  fc
    .tuple(tokens, fc.array(gap, { minLength: 400, maxLength: 400 }))
    .map(([items, gaps]) =>
      items.map((item, index) => (index ? gaps[index]! : "") + item).join(""),
    );

const word = fc.oneof(
  { weight: 8, arbitrary: chars("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZéüñ", 1, 12) },
  { weight: 1, arbitrary: fc.constantFrom("😀", "🚀", "☀", "👍") },
);
const sentenceEnd = fc.constantFrom("", "", "", ".", "!", ",", "?");
const prose = spaced(
  upTo(
    fc.tuple(word, sentenceEnd).map((parts) => parts.join("")),
    400,
  ),
);
const unbroken = fc
  .tuple(fc.constantFrom("a", "é", "😀", "!", "x😀"), fc.noBias(fc.integer({ min: 1, max: 4500 })))
  .map(([unit, length]) => unit.repeat(Math.ceil(length / unit.length)));
const segment = fc.oneof(prose, unbroken);
const reply = spaced(fc.tuple(segment, segment, segment));

const codeLine = fc
  .array(chars("abcdefghijklmnopqrstuvwxyz", 1, 10), { minLength: 1, maxLength: 8 })
  .map((line) => line.join(" "));
const replyWithCode = fc.tuple(prose, upTo(codeLine, 300), prose).map(([intro, lines, outro]) => ({
  body: `${intro}\n\n\`\`\`text\n${lines.join("\n")}\n\`\`\`\n\n${outro}`,
  text: [intro, ...lines, outro].join("\n"),
}));

describe.each<Provider>(["telegram", "whatsapp"])(
  "splitOutboundBody properties for %s",
  (provider) => {
    it("keeps every part within the limit, both as queued and as sent", () => {
      fc.assert(
        fc.property(reply, (body) => {
          for (const { part, sent } of deliver(provider, body)) {
            expect(part.length).toBeLessThanOrEqual(LIMIT);
            expect(sent.length).toBeLessThanOrEqual(LIMIT);
          }
        }),
        { seed: 42, numRuns: 8 },
      );
    });

    it("sends no blank part and never half of a UTF-16 pair", () => {
      fc.assert(
        fc.property(reply, (body) => {
          for (const { part, sent } of deliver(provider, body)) {
            expect(sent.trim()).not.toBe("");
            expect(/[\uD800-\uDFFF]/u.test(part)).toBe(false);
            expect(/[\uD800-\uDFFF]/u.test(sent)).toBe(false);
          }
        }),
        { seed: 42, numRuns: 8 },
      );
    });

    it("delivers the reply's text once and in order, dropping only whitespace at the cuts", () => {
      fc.assert(
        fc.property(reply, (body) => {
          const visible = deliver(provider, body).map((delivery) => delivery.visible);
          expect(textLeftAfter(body, visible)).toBe("");
        }),
        { seed: 42, numRuns: 8 },
      );
    });

    it("delivers the words of a reply with a long code block once and in order", () => {
      fc.assert(
        fc.property(replyWithCode, ({ body, text }) => {
          const visible = deliver(provider, body).map((delivery) => delivery.visible);
          expect(words(visible.join("\n"))).toEqual(words(text));
        }),
        { seed: 42, numRuns: 2 },
      );
    });
  },
);
