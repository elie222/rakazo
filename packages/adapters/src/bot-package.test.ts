import { spawnSync } from "node:child_process";
import {
  BOT_PACKAGE_FORMAT,
  BOT_PACKAGE_MAX_BYTES,
  BotPackageDocumentSchema,
} from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalBotPackageJson,
  parseBotPackageSource,
  prepareBotPackageDocument,
} from "./bot-package.js";

const skill =
  "---\r\nname: sample\r\ndescription: Exact instructions\r\nnotes: |+\r\n  retain blank lines\r\n\r\n---\r\n\r\nOriginal body.\r\n\r\n";
const document = () => ({
  format: BOT_PACKAGE_FORMAT,
  profile: { name: "Example", instructions: "Line one.\n\nContact support@example.test.\n" },
  skills: [{ name: "sample", description: "Exact instructions", content: skill }],
  routines: [{ name: "Daily", prompt: "Check status", crons: ["0 9 * * *"], timezone: "UTC" }],
  connections: [{ name: "Mail", note: "Read authorized inbox" }],
  memory: [{ path: "MEMORY.md", content: "Explicit note.\n" }],
});
const parse = (value: unknown, includeMemory = false) =>
  parseBotPackageSource(JSON.stringify(value), { includeMemory });

describe("bounded portable Bot JSON", () => {
  it("preserves normal profile text and self-contained frontmatter byte for byte", () => {
    const result = parse(document());
    expect(result.document.profile.instructions).toBe(document().profile.instructions);
    expect(result.document.skills[0]?.content).toBe(skill);
    expect(result.document.memory).toEqual([]);
    expect(result.availableMemoryCount).toBe(1);
    expect(JSON.parse(result.json)).toEqual(result.document);
    expect(result.leftOut).toContainEqual(
      expect.objectContaining({ kind: "memory", name: "memory" }),
    );
    expect(
      parseBotPackageSource(canonicalBotPackageJson(result.document), { includeMemory: false })
        .document,
    ).toEqual(result.document);
  });
  it("includes memory only when selected and binds name overrides before canonical serialization", () => {
    const result = parseBotPackageSource(JSON.stringify(document()), {
      name: "A copy",
      includeMemory: true,
    });
    expect(result.document.memory).toEqual(document().memory);
    expect(result.document.profile.name).toBe("A copy");
    expect(JSON.parse(result.json)).toEqual(result.document);
  });
  it.each(["openmaus.grok/1", "grokbot-bundle/v1"])(
    "reads %s JSON and fenced JSON without guessing absent instructions",
    (format) => {
      const json = JSON.stringify({
        format,
        name: "Public card",
        skills: [{ name: "self-contained", instructions: "Follow the policy" }, "Only a name"],
        routines: [
          { name: "Daily", task: "Summarize", schedule: "every weekday at 9am", timezone: "UTC" },
          { name: "Event", task: "React", trigger: "when mail arrives" },
        ],
        plugins: [{ name: "Mail", endpoint: "https://example.test", token: "unexported" }],
        memories: ["Remember explicitly"],
      });
      const result = parseBotPackageSource(`Example:\n\`\`\`json\n${json}\n\`\`\``, {
        includeMemory: false,
      });
      expect(result.document.profile.instructions).toBe("");
      expect(result.document.skills).toHaveLength(1);
      expect(result.document.routines[0]?.crons).toEqual(["0 9 * * 1,2,3,4,5"]);
      expect(result.document.routines).toHaveLength(1);
      expect(result.document.connections).toEqual([{ name: "Mail", note: "" }]);
      expect(JSON.parse(result.json)).toEqual(result.document);
      expect(result.leftOut).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "instructions" }),
          expect.objectContaining({ kind: "skill" }),
          expect.objectContaining({ kind: "routine" }),
        ]),
      );
    },
  );
  it.each(["", "json", "JsOn"])(
    "preserves fenced JSON with the %j label and JavaScript leading whitespace",
    (label) => {
      const source = `Before:\n\`\`\`${label}\t\r\n\uFEFF\u00A0\u2028\u2029${JSON.stringify(document())}\n\`\`\`\n{"outside":"not the export"}`;
      expect(parseBotPackageSource(source, { includeMemory: false }).document.profile.name).toBe(
        "Example",
      );
    },
  );
  it("keeps the fenced candidate limit and skips invalid earlier fences", () => {
    const fence = `\`\`\`json\n${JSON.stringify(document())}\n\`\`\``;
    const prefix = "```not a package```\n";
    const suffix = '\n{"outside":"not the export"}';
    expect(
      parseBotPackageSource(`${prefix.repeat(8)}${fence}${suffix}`, { includeMemory: false })
        .document.profile.name,
    ).toBe("Example");
    expect(() =>
      parseBotPackageSource(`${prefix.repeat(9)}${fence}${suffix}`, { includeMemory: false }),
    ).toThrow("Paste a supported JSON");
  });
  it("bounds malformed fenced exports in a child process without losing JSON fallback", () => {
    const moduleUrl = new URL("./bot-package.ts", import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import { parseBotPackageSource } from ${JSON.stringify(moduleUrl)};
      const prefix = String.fromCharCode(96).repeat(3) + 'json\\n' + ' '.repeat(1024 * 1024);
      assert.throws(() => parseBotPackageSource(prefix + '!', { includeMemory: false }),
        /Paste a supported JSON/);
      const json = ${JSON.stringify(JSON.stringify(document()))};
      assert.equal(parseBotPackageSource(prefix + json, { includeMemory: false })
        .document.profile.name, 'Example');
      assert.throws(() => parseBotPackageSource(String.fromCharCode(96).repeat(1024 * 1024),
        { includeMemory: false }), /Paste a supported JSON/);
      process.stdout.write('bounded and faithful');
    `;
    const child = spawnSync(
      process.execPath,
      ["--import=tsx", "--input-type=module", "-e", script],
      {
        encoding: "utf8",
        timeout: 8000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: "" },
      },
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("bounded and faithful");
  });
  it("reports omitted fields by path and never echoes credential values", () => {
    const value = {
      ...document(),
      accessToken: "private-placeholder",
      profile: { ...document().profile, modelId: "private-model" },
    };
    const result = parse(value);
    expect(result.leftOut).toContainEqual(
      expect.objectContaining({ kind: "secrets", name: "package.accessToken" }),
    );
    expect(result.leftOut).toContainEqual(expect.objectContaining({ name: "profile.modelId" }));
    expect(JSON.stringify(result)).not.toContain("private-placeholder");
    expect(JSON.stringify(result)).not.toContain("private-model");
  });
  it("redacts recognized credential strings but retains ordinary contact emails", () => {
    const value = document();
    value.profile.instructions += `\nAuthorization: Bearer ${"a".repeat(48)}\n`;
    const result = parse(value);
    expect(result.document.profile.instructions).toContain("support@example.test");
    expect(result.document.profile.instructions).not.toContain("a".repeat(48));
    expect(result.leftOut).toContainEqual(
      expect.objectContaining({ kind: "secrets", name: "profile.instructions" }),
    );
  });
  it.each([
    "../outside",
    "/absolute",
    "C:relative",
    "https:notes",
    "a//b",
    "a/./b",
    "a\\b",
    "line\nfeed",
  ])("rejects unsafe memory path %s without echoing contents", (path) => {
    const value = document();
    value.memory = [{ path, content: "private source text" }];
    expect(() => parse(value, true)).toThrow("unsupported or oversized fields");
  });
  it("rejects duplicate memory paths and excess aggregate memory", () => {
    const value = document();
    value.memory.push({ ...value.memory[0]! });
    expect(() => parse(value, true)).toThrow("distinct");
    value.memory = Array.from({ length: 5 }, (_, index) => ({
      path: `${index}.md`,
      content: "x".repeat(256 * 1024),
    }));
    expect(() => parse(value, true)).toThrow("1 MiB");
  });
  it("enforces UTF8 file bytes independently of character and RPC limits", () => {
    const source = "中".repeat(Math.floor(BOT_PACKAGE_MAX_BYTES / 3) + 1);
    expect(source.length).toBeLessThan(BOT_PACKAGE_MAX_BYTES);
    expect(() => parseBotPackageSource(source, { includeMemory: false })).toThrow("4 MiB");
    const value = document();
    value.skills[0]!.content = buildSkillMd({
      name: "sample",
      description: "Exact instructions",
      body: "中".repeat(34000),
    });
    expect(() => parse(value)).toThrow("unsupported or oversized");
  });
  it.each([
    ["skills", 201],
    ["routines", 51],
    ["connections", 31],
    ["memory", 101],
  ] as const)("caps %s before parsing individual entries", (key, size) => {
    expect(() => parse({ ...document(), [key]: Array.from({ length: size }, () => ({})) })).toThrow(
      "too many",
    );
  });
  it("accepts 200 self-contained Skills independently of smaller legacy caps", () => {
    const value = document();
    value.skills = Array.from({ length: 200 }, (_, index) => {
      const name = `skill-${index}`;
      return {
        name,
        description: "Instructions",
        content: buildSkillMd({ name, description: "Instructions", body: "Do work" }),
      };
    });
    expect(parse(value).document.skills).toHaveLength(200);
  });
  it("rejects pathological nesting, nodes and omission count before constructing enormous validation errors", () => {
    let root: unknown = {};
    for (let index = 0; index < 35; index++) root = { next: root };
    expect(() => parse({ ...document(), extra: root })).toThrow("too complex");
    expect(() =>
      parse({ ...document(), extra: Array.from({ length: 100001 }, () => null) }),
    ).toThrow("too complex");
    expect(() =>
      parse({
        ...document(),
        ...Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [`unknown${index}`, "x"])),
      }),
    ).toThrow("too many omitted");
  });
  it("rejects invalid or mixed schedules and mismatched Skill metadata", () => {
    const value = document();
    value.routines[0]!.crons = ["invalid"];
    expect(() => parse(value)).toThrow("schedule is invalid");
    value.routines[0]!.crons = ["@once", "0 9 * * *"];
    expect(() => parse(value)).toThrow("cannot be mixed");
    value.routines = [];
    value.skills[0]!.name = "mismatch";
    expect(() => parse(value)).toThrow("metadata must match");
  });
  it.each([
    "https://example.test/share",
    "grokbot:public-card",
    "not JSON",
    '{"format":"unknown"}',
  ])("refuses unsupported source %s without fetching", (source) => {
    expect(() => parseBotPackageSource(source, { includeMemory: false })).toThrow();
  });
  it("uses plain clock fallback for an unreadable cron and reports external connection fields", () => {
    const result = parse({
      format: "openmaus.grok/1",
      name: "Clock",
      instructions: "Keep text",
      routines: [
        { name: "Fallback", prompt: "Work", cron: "bad", schedule: "every day at 9 am" },
        { name: "Event", prompt: "React", schedule: "every day at 9am whenever a page opens" },
      ],
      plugins: [
        {
          name: "Mail",
          endpoint: "https://example.test",
          headers: { Authorization: "unexported" },
        },
        { id: "private-source-id" },
      ],
    });
    expect(result.document.routines.map((routine) => routine.crons)).toEqual([["0 9 * * *"]]);
    expect(result.document.connections).toEqual([{ name: "Mail", note: "" }]);
    expect(result.leftOut).toContainEqual(
      expect.objectContaining({ name: "connections[0].endpoint" }),
    );
    expect(result.leftOut).toContainEqual(expect.objectContaining({ name: "connections[1].id" }));
    expect(JSON.stringify(result)).not.toContain("private-source-id");
  });
  it("reports native one-shot and event routines as requiring manual setup", () => {
    const value = document();
    value.routines = [
      { ...value.routines[0]!, crons: ["@once"] },
      { ...value.routines[0]!, crons: [] },
    ];
    const result = parse(value);
    expect(result.document.routines).toEqual([]);
    expect(result.leftOut.filter((entry) => entry.kind === "routine")).toHaveLength(2);
  });
  it("accepts exact 4 MiB raw and canonical boundaries and rejects the next byte", () => {
    const rawBase = JSON.stringify({ ...document(), padding: "" });
    const raw = rawBase.replace(
      '"padding":""',
      `"padding":"${"x".repeat(BOT_PACKAGE_MAX_BYTES - Buffer.byteLength(rawBase))}"`,
    );
    expect(Buffer.byteLength(raw)).toBe(BOT_PACKAGE_MAX_BYTES);
    expect(parseBotPackageSource(raw, { includeMemory: false }).document.profile.name).toBe(
      "Example",
    );
    expect(() => parseBotPackageSource(`${raw} `, { includeMemory: false })).toThrow("4 MiB");
    const value = document();
    value.memory = [];
    value.skills = Array.from({ length: 43 }, (_, index) => {
      const name = `boundary-${index}`;
      return {
        name,
        description: "Exact",
        content: buildSkillMd({ name, description: "Exact", body: "x".repeat(96000) }),
      };
    });
    const normalized = BotPackageDocumentSchema.parse(value);
    let remaining = BOT_PACKAGE_MAX_BYTES - Buffer.byteLength(canonicalBotPackageJson(normalized));
    for (const skill of normalized.skills) {
      const added = Math.min(remaining, 100000 - Buffer.byteLength(skill.content));
      skill.content += "x".repeat(added);
      remaining -= added;
    }
    expect(remaining).toBe(0);
    const canonical = canonicalBotPackageJson(normalized);
    expect(Buffer.byteLength(canonical)).toBe(BOT_PACKAGE_MAX_BYTES);
    expect(parseBotPackageSource(canonical, { includeMemory: false }).document.skills).toHaveLength(
      43,
    );
    normalized.profile.instructions += "x";
    expect(() => canonicalBotPackageJson(normalized)).toThrow("4 MiB");
  });
  it("tracks exactly 2000 omissions without reserializing prior entries", () => {
    const value = {
      ...document(),
      memory: [],
      ...Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`unknown${index}`, true])),
    };
    const stringify = vi.spyOn(JSON, "stringify");
    const started = performance.now();
    let result: ReturnType<typeof parse>;
    try {
      result = parse(value);
      expect(
        stringify.mock.calls.filter(([entry]) => Array.isArray(entry) && entry[0]?.kind),
      ).toHaveLength(0);
    } finally {
      stringify.mockRestore();
    }
    expect(result.leftOut).toHaveLength(2000);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(() => parse({ ...value, oneMore: true })).toThrow("too many omitted");
  });
  it("accounts for UTF8, JSON escaping, brackets and commas at the exact omission byte limit", () => {
    const keys = Array.from({ length: 2000 }, (_, index) => `中${index}`);
    keys[0] = '中"\\0';
    const entries = () =>
      keys.map((key) => ({
        kind: "unsupported",
        name: `package.${key}`,
        reason: "This configuration field is not imported.",
      }));
    const maxBytes = 256 * 1024;
    let remaining = maxBytes - Buffer.byteLength(JSON.stringify(entries()));
    expect(remaining).toBeGreaterThan(0);
    for (let index = 0; index < keys.length; index++) {
      const added = Math.min(remaining, 100 - keys[index]!.length);
      keys[index] += "x".repeat(added);
      remaining -= added;
    }
    expect(remaining).toBe(0);
    const value = () => ({
      ...document(),
      memory: [],
      ...Object.fromEntries(keys.map((key) => [key, true])),
    });
    const exact = parse(value());
    expect(Buffer.byteLength(JSON.stringify(exact.leftOut))).toBe(maxBytes);
    const grow = keys.findIndex((key) => key.length < 100);
    expect(grow).toBeGreaterThan(-1);
    keys[grow] += "x";
    expect(() => parse(value())).toThrow("too many omitted");
    keys[grow] = keys[grow]!.slice(0, -2);
    expect(Buffer.byteLength(JSON.stringify(parse(value()).leftOut))).toBe(maxBytes - 1);
  });
  it("omits oversized field names whole before redaction without exposing a truncated credential", () => {
    const credential = `ghp_${"A".repeat(36)}`;
    const key = `${"x".repeat(95)}${credential}`;
    const result = parse({ ...document(), memory: [], [key]: true, [credential]: true });
    expect(result.leftOut[0]).toEqual(
      expect.objectContaining({
        name: "package.[field 1]",
        reason: expect.stringContaining("name exceeds"),
      }),
    );
    expect(JSON.stringify(result.leftOut)).not.toContain(key.slice(0, 100));
    expect(JSON.stringify(result.leftOut)).not.toContain(credential);
  });
  it("bounds a 200000-quote unsupported key before the synchronous redactor", () => {
    const key = "'".repeat(200000);
    const started = performance.now();
    const result = parse({ ...document(), memory: [], [key]: true });
    expect(result.leftOut).toEqual([expect.objectContaining({ name: "package.[field 1]" })]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
  it("rejects NUL and caps final canonical size as well as original bytes", () => {
    const value = document();
    value.profile.instructions += "\0";
    expect(() => parse(value)).toThrow("NUL");
    expect(() =>
      prepareBotPackageDocument({
        ...document(),
        skills: Array.from({ length: 60 }, (_, index) => {
          const name = `skill-${index}`;
          return {
            name,
            description: "Test",
            content: buildSkillMd({ name, description: "Test", body: "x".repeat(75000) }),
          };
        }),
      }),
    ).toThrow("4 MiB");
    expect(BotPackageDocumentSchema.safeParse(document()).success).toBe(true);
  });
});
