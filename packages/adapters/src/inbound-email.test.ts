import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth";
import { describe, expect, it } from "vitest";
import type { InboundEmailResolver } from "./inbound-email.js";
import { INBOUND_EMAIL_TEXT_MAX_CHARS, readInboundEmail } from "./inbound-email.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");

/** DNS with one DKIM key, published for example.test and news.example.test as selector "s1". */
const resolver: InboundEmailResolver = async (domain, rrtype) => {
  if (
    rrtype === "TXT" &&
    (domain === "s1._domainkey.example.test" || domain === "s1._domainkey.news.example.test")
  ) {
    return [[`v=DKIM1; k=rsa; p=${publicDer}`]];
  }
  throw Object.assign(new Error(`no ${rrtype} for ${domain}`), { code: "ENOTFOUND" });
};

function message(headers: string[], body = "Please summarize the attached report.\r\n") {
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

const plain = [
  "From: Ada Lovelace <ada@example.test>",
  "To: Bot <helper@bots.test>",
  "Cc: grace@example.test",
  "Subject: Weekly report",
  "Date: Thu, 05 Nov 2026 10:00:00 +0000",
  "Message-ID: <weekly-1@example.test>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
];

async function signed(raw: string, signingDomain = "example.test", headerList?: string) {
  const result = await dkimSign(raw, {
    ...(headerList ? { headerList } : {}),
    signatureData: [{ signingDomain, selector: "s1", privateKey: privatePem }],
  });
  expect(result.errors).toEqual([]);
  return result.signatures + raw;
}

const bytes = (raw: string) => new TextEncoder().encode(raw);

describe("readInboundEmail", () => {
  it("authenticates a message signed by its From domain", async () => {
    const email = await readInboundEmail(bytes(await signed(message(plain))), { resolver });

    expect(email.key).toMatch(/^dkim:/);
    expect(email).toMatchObject({
      from: { address: "ada@example.test", name: "Ada Lovelace" },
      authenticated: true,
      to: ["helper@bots.test"],
      cc: ["grace@example.test"],
      subject: "Weekly report",
      text: "Please summarize the attached report.",
      automated: false,
      attachments: [],
    });
  });

  it("does not authenticate unsigned, tampered or unaligned mail", async () => {
    const unsigned = await readInboundEmail(bytes(message(plain)), { resolver });
    const tampered = await readInboundEmail(
      bytes((await signed(message(plain))).replace("Please", "Kindly")),
      { resolver },
    );
    const otherDomain = await readInboundEmail(
      bytes(
        await signed(
          message(plain.map((line) => line.replace("ada@example.test", "ada@other.test"))),
        ),
      ),
      { resolver },
    );

    expect(unsigned.authenticated).toBe(false);
    expect(tampered.authenticated).toBe(false);
    expect(otherDomain).toMatchObject({
      authenticated: false,
      from: { address: "ada@other.test" },
    });
  });

  it("does not authenticate a subdomain signing for its parent's addresses", async () => {
    const email = await readInboundEmail(bytes(await signed(message(plain), "news.example.test")), {
      resolver,
    });

    expect(email.authenticated).toBe(false);
  });

  it("keys a resent copy by its signature, whatever Message-ID it is given", async () => {
    const original = await signed(message(plain), "example.test", "From:To:Cc:Subject:Date");
    const resent = original.replace("<weekly-1@example.test>", "<another@example.test>");

    const first = await readInboundEmail(bytes(original), { resolver });
    const second = await readInboundEmail(bytes(resent), { resolver });

    expect(second.authenticated).toBe(true);
    expect(second.key).toBe(first.key);
  });

  it("does not authenticate recipients the signature leaves out or a To added on top", async () => {
    const toUnsigned = await readInboundEmail(
      bytes(await signed(message(plain), "example.test", "From:Subject:Date:Message-ID")),
      { resolver },
    );
    const injected = await readInboundEmail(
      bytes(
        `To: helper@bots.test\r\n${await signed(message(plain.filter((line) => !line.startsWith("To:"))))}`,
      ),
      { resolver },
    );

    expect(toUnsigned.authenticated).toBe(false);
    expect(injected.authenticated).toBe(false);
  });

  it("marks auto-replies and list mail as automated", async () => {
    const cases = [
      "Auto-Submitted: auto-replied",
      "Precedence: bulk",
      "List-Id: <news.example.test>",
    ];
    for (const extra of cases) {
      const email = await readInboundEmail(bytes(message([...plain, extra])), { resolver });
      expect(email.automated, extra).toBe(true);
    }
    const hidden = await readInboundEmail(
      bytes(message([...plain, "Auto-Submitted: no", "Auto-Submitted: auto-replied"])),
      { resolver },
    );
    expect(hidden.automated).toBe(true);
    const human = await readInboundEmail(bytes(message([...plain, "Auto-Submitted: no"])), {
      resolver,
    });
    expect(human.automated).toBe(false);
  });

  it("reads HTML-only bodies, attachments and long text", async () => {
    const boundary = "b1";
    const raw = message(
      [
        ...plain.filter(
          (line) => !line.startsWith("Content-Type") && !line.startsWith("Message-ID"),
        ),
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ],
      [
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        "",
        `<p>Hello <b>bot</b></p><script>steal()</script><p>${"x".repeat(INBOUND_EMAIL_TEXT_MAX_CHARS)}</p>`,
        `--${boundary}`,
        "Content-Type: text/csv",
        'Content-Disposition: attachment; filename="report.csv"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("a,b\n1,2\n").toString("base64"),
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );

    const email = await readInboundEmail(bytes(raw), { resolver });

    expect(email.text.startsWith("Hello bot")).toBe(true);
    expect(email.text).not.toContain("steal");
    expect(email.text.endsWith("[…]")).toBe(true);
    expect(email.key).toMatch(/^sha256:/);
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({ name: "report.csv", mimeType: "text/csv" });
    expect(new TextDecoder().decode(email.attachments[0]?.bytes)).toBe("a,b\n1,2\n");
  });
});
