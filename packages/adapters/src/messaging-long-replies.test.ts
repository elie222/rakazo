import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const filler = Array.from(
  { length: 160 },
  (_, line) => `Sentence ${line} of the reply fills it past one message.`,
).join("\n\n");

afterEach(() => vi.unstubAllGlobals());

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

  it("sends a reply nested too deep to render as the text it was written as", async () => {
    const body = `${"- ".repeat(747)}a`;
    const sends = await deliver(provider, body);

    expect(sends).toHaveLength(1);
    expect(sends[0]?.replace(/\\/g, "")).toBe(body);
  });
});
