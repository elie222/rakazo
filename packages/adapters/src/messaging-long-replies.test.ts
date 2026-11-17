import type { AdapterContext } from "@rakazo/adapter-kit";
import type { TestSink } from "@rakazo/logging";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { messagingPlatformsFromEnv, splitOutboundBody } from "./messaging-platforms.js";

const LIMIT = 4096;

const context: AdapterContext = {
  operationId: "op-test",
  traceId: "trace-test",
  spaceId: "space-test",
  userId: "user-test",
  signal: new AbortController().signal,
};

type Provider = "telegram" | "whatsapp";

const THREAD: Record<Provider, string> = {
  telegram: "telegram:123",
  whatsapp: "whatsapp:123:15551234567",
};

/**
 * Splits a reply and posts each part through the real adapter, replacing only HTTP. Returns the
 * text of every message the platform's send call received.
 */
async function deliver(provider: Provider, body: string): Promise<string[]> {
  const sends: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const method = new URL(input).pathname.split("/").at(-1);
      if (method === "getMe") {
        return Response.json({ ok: true, result: { id: 999, is_bot: true, username: "testbot" } });
      }
      if (method === "sendRichMessage") {
        return Response.json(
          { ok: false, error_code: 404, description: "Not Found" },
          { status: 404 },
        );
      }
      const payload = JSON.parse(String(init.body)) as { text: string | { body: string } };
      if (typeof payload.text !== "string") {
        sends.push(payload.text.body);
        return Response.json({ messages: [{ id: `wamid.${sends.length}` }] });
      }
      sends.push(payload.text);
      return Response.json({
        ok: true,
        result: {
          message_id: sends.length,
          date: 1_700_000_000,
          chat: { id: 123, type: "private" },
          from: { id: 999, is_bot: true, first_name: "Test Bot" },
          text: payload.text,
        },
      });
    }),
  );
  const surface = new ChatSdkMessagingSurface(
    messagingPlatformsFromEnv({
      telegramBotToken: "test-token",
      telegramWebhookSecret: "test-webhook-secret",
      whatsappAccessToken: "test-token",
      whatsappPhoneNumberId: "123",
      whatsappAppSecret: "test-secret",
      whatsappVerifyToken: "test-verify",
    }),
  );
  for (const part of splitOutboundBody(provider, body)) {
    await surface.sendToThread({ threadId: THREAD[provider], body: part }, context);
  }
  return sends;
}

/** The code a person sees in a sent message: the contents of each fenced block, as written. */
function codeBlocks(provider: Provider, sent: string): string[] {
  return [...sent.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)].map(([, code = ""]) =>
    provider === "telegram" ? code.replace(/\\([`\\])/g, "$1") : code,
  );
}

/** A sent message's text outside its code blocks. */
function prose(sent: string): string {
  return sent.replace(/```[^\n]*\n[\s\S]*?\n```/g, "");
}

/** What a person reads in a sent message: a link by its label, without the platform's escapes. */
function visibleText(provider: Provider, sent: string): string {
  const labelled =
    provider === "telegram"
      ? sent.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      : sent.replace(/<(https?:[^>\s]+)>/g, "$1");
  return labelled.replace(/\\/g, "");
}

const filler = Array.from(
  { length: 160 },
  (_, line) => `Sentence ${line} of the reply fills it past one message.`,
).join("\n\n");

const logger = getLogger();
let logs: TestSink;

beforeEach(() => {
  logs = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [logs] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  installLogger(logger);
});

describe("a Telegram reply longer than one message", () => {
  it("shows a code block as written, indentation kept", async () => {
    const code = "def f(a, b):\n    return a * b + __init__[0] # done!";
    const sends = await deliver("telegram", `\`\`\`python\n${code}\n\`\`\`\n\n${filler}`);

    expect(sends.length).toBeGreaterThan(1);
    expect(sends[0]).toContain(`\`\`\`python\n${code}\n\`\`\``);
    expect(sends.flatMap((sent) => codeBlocks("telegram", sent))).toEqual([code]);
  });

  it("keeps a code block that spans messages exact, each piece in its own block", async () => {
    const lines = Array.from(
      { length: 300 },
      (_, line) => `    if x[${line}] > __min__: total += x[${line}] * 2  # line ${line}!`,
    );
    const sends = await deliver("telegram", `\`\`\`python\n${lines.join("\n")}\n\`\`\``);

    expect(sends.length).toBeGreaterThan(1);
    for (const sent of sends) expect(sent).toMatch(/^```python\n[\s\S]*\n```$/);
    expect(sends.flatMap((sent) => codeBlocks("telegram", sent)).join("\n")).toBe(lines.join("\n"));
  });

  it("sends a bare address as a working link", async () => {
    const sends = await deliver(
      "telegram",
      `**Docs** are at https://example.com/a_b?x=1\n\n${filler}`,
    );

    expect(sends.length).toBeGreaterThan(1);
    expect(sends[0]).toContain(
      "*Docs* are at [https://example\\.com/a\\_b?x\\=1](https://example.com/a_b?x=1)\n",
    );
  });

  it("keeps list numbers, bullets and quote markers", async () => {
    const lists = "1. Open the app\n2. Tap Settings\n\n- Wi-Fi\n- Sound\n\n> Restart to apply";
    const [short] = await deliver("telegram", lists);
    const sends = await deliver("telegram", `${lists}\n\n${filler}`);

    expect(short).toBe(
      "1\\. Open the app\n2\\. Tap Settings\n\n\\- Wi\\-Fi\n\\- Sound\n\n>Restart to apply",
    );
    expect(sends.length).toBeGreaterThan(1);
    expect(sends[0]?.startsWith(`${short}\n\n`)).toBe(true);
  });

  it("continues a list that spans messages at the next number", async () => {
    const steps = Array.from(
      { length: 150 },
      (_, step) => `${step + 1}. Step ${step + 1} of the setup guide, described at some length.`,
    );
    const sends = await deliver("telegram", steps.join("\n"));

    expect(sends.length).toBeGreaterThan(1);
    const numbers = sends.flatMap((sent) =>
      [...sent.matchAll(/^(\d+)\\\. Step/gm)].map(([, number]) => Number(number)),
    );
    expect(numbers).toEqual(steps.map((_, step) => step + 1));
  });

  it("shows entities inside code as written", async () => {
    const sends = await deliver("telegram", `Write \`&amp;\` and \`&lt;div&gt;\`.\n\n${filler}`);

    expect(sends.length).toBeGreaterThan(1);
    expect(sends[0]).toContain("Write `&amp;` and `&lt;div&gt;`\\.\n");
  });
});

describe("a WhatsApp reply longer than one message", () => {
  it("closes a code block at the end of a part and reopens it in the next", async () => {
    const lines = Array.from(
      { length: 300 },
      (_, line) => `    total += __init__[${line}] * 2  # line ${line}`,
    );
    const body = `Run this:\n\n\`\`\`python\n${lines.join("\n")}\n\`\`\`\n\nThen restart the app.`;
    const sends = await deliver("whatsapp", body);

    expect(sends.length).toBeGreaterThan(2);
    for (const sent of sends) expect(sent.split("```").length % 2).toBe(1);
    expect(sends.flatMap((sent) => codeBlocks("whatsapp", sent)).join("\n")).toBe(lines.join("\n"));
    expect(sends.map(prose).join("").replace(/\s+/g, " ")).toBe("Run this: Then restart the app.");
  });

  it("keeps bold text whole when it would cross a cut", async () => {
    const bold = `**${"very important ".repeat(40).trim()}**`;
    const sends = await deliver("whatsapp", `${"plain words ".repeat(330)}${bold} and the end.`);

    expect(sends).toHaveLength(2);
    expect(sends.join("")).not.toContain("**");
    expect(sends[1]).toBe(`*${"very important ".repeat(40).trim()}* and the end.`);
  });

  it("makes each piece of bold text too long for one message bold", async () => {
    const sends = await deliver("whatsapp", `**${"very important ".repeat(400).trim()}**`);

    expect(sends.length).toBeGreaterThan(1);
    for (const sent of sends) expect(sent).toMatch(/^\*[a-z]+( [a-z]+)*\*$/);
    expect(sends.join(" ").split(" ")).toHaveLength(800);
  });
});

describe.each<Provider>(["telegram", "whatsapp"])("a long %s reply's parts", (provider) => {
  it.each([
    ["spaces before long text", " ".repeat(1029) + "a".repeat(4097)],
    ["blank lines before long text", "\n".repeat(2049) + "a".repeat(4097)],
    ["blank lines inside a code block", `\`\`\`\na\n${"\n".repeat(9000)}b\n\`\`\``],
    ["a gap inside a sentence", `a${" ".repeat(9000)}b`],
  ])("are never blank: %s", async (_name, body) => {
    const sends = await deliver(provider, body);

    expect(sends.length).toBeGreaterThan(1);
    for (const sent of sends) {
      expect(prose(sent).trim() || codeBlocks(provider, sent).join("").trim()).not.toBe("");
      expect(sent.length).toBeLessThanOrEqual(LIMIT);
    }
    expect(sends.join("").replace(/[\s`]/g, "")).toBe(body.replace(/[\s`]/g, ""));
  });

  it("sends nothing for a reply of only white space", () => {
    expect(splitOutboundBody(provider, " \n\t ".repeat(2000))).toEqual([]);
    expect(splitOutboundBody(provider, " ")).toEqual([]);
  });

  it("ends parts between words", async () => {
    const sends = await deliver(provider, "word ".repeat(1000));

    expect(sends.length).toBeGreaterThan(1);
    for (const sent of sends) expect(sent).toMatch(/^word( word)*$/);
    expect(sends.join(" ").split(" ")).toHaveLength(1000);
  });

  it.each([
    ["flags", "🇫🇷"],
    ["skin tones", "👍🏽"],
    ["joined emoji", "👨‍👩‍👧‍👦"],
  ])("keep emoji of several code points whole: %s", async (_name, emoji) => {
    const sends = await deliver(provider, `a${emoji.repeat(Math.ceil(6000 / emoji.length))}`);

    expect(sends.length).toBeGreaterThan(1);
    for (const sent of sends) expect(sent.replace(/^a/, "").split(emoji).join("")).toBe("");
  });

  it("cuts inside one character that is longer than a message", async () => {
    // A letter under thousands of combining marks is a single character to the reader.
    const body = `a${"\u0301".repeat(6000)}`;
    const sends = await deliver(provider, body);

    expect(sends.length).toBeGreaterThan(1);
    for (const sent of sends) expect(sent.length).toBeLessThanOrEqual(LIMIT);
    expect(sends.join("")).toBe(body);
  });

  it("sends a reply nested too deep to render as the text it was written as", async () => {
    const body = `${"- ".repeat(747)}a`;
    const sends = await deliver(provider, body);

    expect(sends).toHaveLength(1);
    expect(sends[0]?.replace(/\\/g, "")).toBe(body);
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      level: "warn",
      message: "sending a whole reply as literal text: splitting its Markdown failed",
      error: { name: "RangeError", stack: expect.stringContaining("RangeError") },
    });
  });

  it("writes reference-style links and images inline, so each part has their addresses", async () => {
    const body = [
      "Read [the docs][docs] and see ![the chart][chart].",
      "> A quote that cites [the docs][docs].",
      filler,
      "- Then [the docs][docs] again, and [the site].",
      '[docs]: https://example.com/docs "Docs"\n[chart]: https://example.com/chart.png',
      "[the site]: https://example.com/",
      "> [quoted]: https://example.com/quoted",
    ].join("\n\n");
    const sends = await deliver(provider, body);

    expect(sends.length).toBeGreaterThan(1);
    expect(sends[0]).toContain("Read [the docs](https://example.com/docs");
    expect(sends[0]).toContain("[the chart](https://example.com/chart.png)");
    expect(sends[0]).toContain("cites [the docs](https://example.com/docs");
    expect(sends.at(-1)).toContain("Then [the docs](https://example.com/docs");
    expect(sends.at(-1)).toContain("[the site](https://example.com/)");
    // No reference is left without its definition, and no definition is sent as text.
    for (const sent of sends) expect(sent).not.toMatch(/\]\[|\]:/);
    expect(logs.events).toEqual([]);
  });

  it("sends no definition that nothing refers to", async () => {
    const sends = await deliver(provider, `${filler}\n\n[unused]: https://example.com/unused`);

    expect(sends.length).toBeGreaterThan(1);
    expect(sends.join("\n")).not.toContain("unused");
    expect(sends.join("\n")).toContain("Sentence 159 of the reply");
  });

  it("keeps a footnote's marker and text as they were written", async () => {
    const sends = await deliver(
      provider,
      `A claim.[^1]\n\n${filler}\n\n[^1]: The source of *the claim*.\n\n    Its second paragraph.`,
    );

    expect(sends.length).toBeGreaterThan(1);
    expect(sends[0]?.replace(/\\/g, "")).toContain("A claim.[^1]");
    expect(sends.at(-1)?.replace(/\\/g, "")).toContain(
      "[^1]: The source of _the claim_.\n\nIts second paragraph.",
    );
  });

  it.each([
    ["a link", "[here]("],
    ["an image", "![here]("],
  ])(
    "sends only %s too long for one message as the text it was written as",
    async (_name, open) => {
      const sends = await deliver(
        provider,
        `**Before** it.\n\n1. One\n2. See ${open}https://example.com/${"z".repeat(5000)}) for more\n3. **Three**\n\n**After** it.`,
      );

      expect(sends.every((sent) => sent.length <= LIMIT)).toBe(true);
      expect(sends[0]).toContain("*Before* it");
      expect(sends.at(-1)).toContain("*Three*");
      expect(sends.at(-1)).toContain("*After* it");
      const shown = sends.map((sent) => visibleText(provider, sent)).join("");
      expect(shown).toContain(`${open}https://example.com/zzz`);
      expect(shown.match(/z/g)).toHaveLength(5000);
      expect(shown).toContain("zzz) for more");
      expect(logs.events).toEqual([]);
    },
  );

  it("cuts an address too long for one message between whole characters", async () => {
    const written = `[here](https://example.com/${"😀".repeat(2500)})`;
    const sends = await deliver(provider, written);

    expect(sends.length).toBeGreaterThan(1);
    for (const sent of sends) {
      expect(sent.length).toBeLessThanOrEqual(LIMIT);
      expect(/[\uD800-\uDFFF]/u.test(sent)).toBe(false);
    }
    expect(sends.map((sent) => visibleText(provider, sent)).join("")).toBe(written);
  });
});
