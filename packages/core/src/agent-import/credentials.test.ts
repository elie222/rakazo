import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import { credentialRanges, looksLikeCredential } from "./credentials.js";
import { parseAgentImport } from "./index.js";

// Synthetic values, built from parts so no scanner mistakes this file for a leak.
const body = (length: number) => "Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA".repeat(4).slice(0, length);
const join = (...parts: string[]) => parts.join("");

describe("credential shapes", () => {
  it.each([
    ["OpenAI", join("sk", "-", body(40))],
    ["OpenAI project", join("sk", "-proj-", body(40))],
    ["Anthropic", join("sk", "-ant-api03-", body(60))],
    ["OpenRouter", join("sk", "-or-v1-", body(64).toLowerCase())],
    ["GitHub classic", join("gh", "p_", body(36))],
    ["GitHub OAuth", join("gh", "o_", body(36))],
    ["GitHub user", join("gh", "u_", body(36))],
    ["GitHub server", join("gh", "s_", body(36))],
    ["GitHub fine-grained", join("github", "_pat_", body(40))],
    ["Slack", join("xo", "xb-", "1234567890-", body(20))],
    ["AWS", join("AK", "IA", "ABCDEFGH23456789")],
    ["AWS temporary", join("AS", "IA", "ABCDEFGH23456789")],
    ["Google", join("AI", "za", body(35))],
    ["GitLab", join("gl", "pat-", body(20))],
    ["Hugging Face", join("h", "f_", body(34))],
    ["Stripe secret", join("sk", "_live_", body(24))],
    ["Stripe restricted", join("rk", "_live_", body(24))],
    ["private key", join("-----BEGIN ", "OPENSSH PRIVATE", " KEY-----\nAAAA\n")],
    ["bearer", join("Authorization: Bearer ", body(40))],
    ["lowercase bearer", join("authorization: bearer ", body(40))],
    ["uppercase bearer", join("AUTHORIZATION: BEARER ", body(40))],
    // Fixed-prefix shapes need no digit: these tokens can be all letters.
    ["all-letter GitHub", join("gh", "p_", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ")],
    ["all-letter GitLab", join("gl", "pat-", "abcdefghijKLMNOPQRSTuv")],
    ["all-letter Hugging Face", join("h", "f_", "abcdefghijklmnopqrstuvwxyzABCDEF")],
    // Accepted: a long hyphenated word with a digit looks like a key. It only unticks an item.
    ["hyphenated word with a digit", "sk-learn-compatible-estimator-v2-docs"],
  ])("finds a %s key inside Markdown", (_, value) => {
    expect(looksLikeCredential(`Use this:\n\n\`${value}\`\n`)).toBe(true);
  });

  it.each([
    "We trained it with sk-learn and scikit-learn pipelines.",
    "sk-learn-compatible-estimator-interface-docs",
    "A short id like sk-1 or sk-12345.",
    "Keep your API key in .env, never in a prompt. Rotate keys monthly.",
    "Set OPENAI_API_KEY=sk-... in your shell.",
    "sk-your-openrouter-key-goes-here",
    `sk-${"x".repeat(40)}`,
    "Send it as Authorization: Bearer <token>.",
    "The AKIA prefix marks AWS access keys.",
    "ghp_ tokens are GitHub's classic tokens.",
    "-----BEGIN PUBLIC KEY-----",
    "placeholder-openrouter-key",
  ])("ignores %s", (text) => {
    expect(looksLikeCredential(text)).toBe(false);
  });
});

describe("credential ranges", () => {
  const found = (text: string) =>
    credentialRanges(text).map(({ start, end }) => text.slice(start, end));

  it("covers each key and nothing around it", () => {
    const openai = join("sk", "-proj-", body(40));
    const github = join("gh", "p_", body(36));
    expect(found(`Use ${openai}, then \`${github}\`.`)).toEqual([openai, github]);
  });

  it("covers only the token after Bearer", () => {
    const token = body(40);
    expect(found(`Authorization: Bearer ${token}`)).toEqual([token]);
  });

  it("leaves out the period after a token that ends a sentence", () => {
    const token = body(40);
    expect(found(`Send Bearer ${token}.`)).toEqual([token]);
  });

  it("joins a key inside a Bearer token into one range", () => {
    const key = join("sk", "-ant-api03-", body(60));
    expect(found(`Bearer ${key}`)).toEqual([key]);
  });

  describe("AWS secret access keys", () => {
    const id = join("AK", "IA", "ABCDEFGHIJ234567");
    const secret = join(body(20), "/", body(19));

    it("covers one under its name, even with no digit", () => {
      const other = join("AbcdEfgh".repeat(4), "/", "IjkLmn", "+");
      expect(found(`AWS_SECRET_ACCESS_KEY=${secret}\n{ "SecretAccessKey": "${other}" }`)).toEqual([
        secret,
        other,
      ]);
    });

    it("covers one typed at the CLI's configure prompt", () => {
      const prompt = "AWS Secret Access Key [None]: ";
      expect(found(`${prompt}${"AbcdEfgh".repeat(5)}`)).toEqual(["AbcdEfgh".repeat(5)]);
    });

    it("leaves out a value at that prompt too short to be one", () => {
      expect(found(`AWS Secret Access Key [None]: ${"AbcdEfgh".repeat(4)}`)).toEqual([]);
    });

    it("covers an unnamed one beside its access key id", () => {
      expect(found(`Access key ID,Secret access key\n${id},${secret}`)).toEqual([id, secret]);
    });

    it("leaves out an unnamed one with no access key id beside it", () => {
      expect(found(`Checksum ${secret}`)).toEqual([]);
    });

    it("leaves out a hex digest beside an access key id", () => {
      const digest = "3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a";
      expect(found(`${id} was rotated in commit ${digest}`)).toEqual([id]);
    });
  });

  it("covers a private key through its END line", () => {
    const key = join(
      "-----BEGIN ",
      "OPENSSH PRIVATE",
      " KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----",
    );
    expect(found(`Here:\n${key}\nThanks`)).toEqual([key]);
  });

  it("covers a private key with no END line to the end of the text", () => {
    const key = join("-----BEGIN ", "RSA PRIVATE", " KEY-----\nAAAA\nBBBB");
    expect(found(`Here:\n${key}`)).toEqual([key]);
  });

  it("scans many unclosed private key lines in linear time", () => {
    const begin = join("-----BEGIN ", "RSA PRIVATE", " KEY-----\n");
    expectLinearTime(() => credentialRanges(begin.repeat(100_000)));
  });
});

describe("imported items with key-looking text", () => {
  const key = join("sk", "-proj-", body(40));

  it("are flagged from a folder, unchanged", () => {
    const result = parseAgentImport([
      { path: "workspace/SOUL.md", content: "Calm.\n" },
      { path: "workspace/MEMORY.md", content: `Deploy key: ${key}\n` },
      {
        path: "workspace/skills/deploy/SKILL.md",
        content: `---\nname: deploy\ndescription: Ship it\n---\nUse ${key}.\n`,
      },
    ]);
    if ("error" in result) throw new Error(result.error);
    expect(result.instructions.map((item) => item.containsKey)).toEqual([undefined]);
    expect(result.memory.map((item) => [item.containsKey, item.content])).toEqual([
      [true, `Deploy key: ${key}\n`],
    ]);
    expect(result.skills.map((item) => item.containsKey)).toEqual([true]);
    // The match is never put in a title.
    expect(
      JSON.stringify([...result.memory, ...result.skills].map((item) => item.title)),
    ).not.toContain(key);
  });

  it("are flagged in another assistant's document", () => {
    const result = parseAgentImport([
      { path: "agent.md", content: `# Instructions\nAlways send ${key} with requests.\n` },
    ]);
    if ("error" in result) throw new Error(result.error);
    expect(result.source).toBe("document");
    expect(result.instructions.map((item) => item.containsKey)).toEqual([true]);
  });
});

describe("a key only in a title", () => {
  const key = join("sk", "-proj-", body(40));

  it("flags a document memory whose heading is the key", () => {
    const result = parseAgentImport([
      { path: "agent.md", content: `# Instructions\nBe brief.\n\n# Memory\n## ${key}\nNotes.\n` },
    ]);
    if ("error" in result) throw new Error(result.error);
    expect(result.memory.map((item) => item.containsKey)).toEqual([true]);
  });
});
