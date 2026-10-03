import type { BotSecretDestination } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { redactAgentCommandResult } from "./agent-environment.js";
import {
  commandCredentialRedactions,
  forgetBotSecret,
  listBotSecrets,
  loadBotCommandEnvironment,
  requestWithBotSecret,
  resolveLoginFill,
  shellCommandEnvironment,
  storeBotSecret,
} from "./bot-secrets.js";
import { EncryptedSecretStore } from "./secrets.js";

// No database is available offline, so these run against an in-memory stand-in for the
// bot_secrets table. Encryption, validation, and redaction are the real implementations.
type Row = {
  id: string;
  userId: string;
  spaceId: string;
  botId: string;
  name: string;
  origin: string;
  auth: unknown;
  ciphertext: string;
};
type Where = Record<string, unknown>;

function matches(row: Row, where: Where) {
  return Object.entries(where).every(([key, value]) => {
    const field = row[key as keyof Row];
    if (value && typeof value === "object" && "not" in value) return field !== value.not;
    return field === value;
  });
}

function fakeDatabase() {
  let rows: Row[] = [];
  const botSecret = {
    findFirst: vi.fn(
      async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where, take }: { where: Where; take?: number }) =>
      rows
        .filter((row) => matches(row, where))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, take ?? rows.length),
    ),
    count: vi.fn(
      async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where)).length,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      rows.push({ ...data });
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      Object.assign(rows.find((row) => row.id === where.id)!, data);
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = rows.length;
      rows = rows.filter((row) => !matches(row, where));
      return { count: before - rows.length };
    }),
  };
  const client: Record<string, unknown> = { botSecret, $queryRaw: vi.fn(async () => []) };
  client.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(client);
  return {
    rows: () => rows,
    prisma: client as unknown as PrismaClient,
    tx: client as unknown as Prisma.TransactionClient,
  };
}

const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const command = { type: "command" } as const;

function save(
  db: ReturnType<typeof fakeDatabase>,
  name: string,
  plaintext: string,
  destination: Partial<BotSecretDestination> = {},
  saveScope = scope,
) {
  return storeBotSecret({
    tx: db.tx,
    secretStore,
    scope: saveScope,
    destination: { name, origin: "", auth: command, ...destination },
    plaintext,
  });
}

describe("storing a command variable", () => {
  it("stores the value with no site and decrypts it back", async () => {
    const db = fakeDatabase();
    await save(db, "netbird-setup-key", "fake-setup-key-1");
    const [row] = db.rows();
    expect(row).toMatchObject({ name: "netbird-setup-key", origin: "", auth: command });
    expect(row!.ciphertext).not.toContain("fake-setup-key-1");
    expect(secretStore.load(row!.ciphertext, row!.id)).toBe("fake-setup-key-1");
  });

  it("accepts any value up to 16384 characters and nothing longer", async () => {
    const db = fakeDatabase();
    await expect(save(db, "big", "x".repeat(16_384))).resolves.toBeUndefined();
    await expect(save(db, "bigger", "x".repeat(16_385))).rejects.toThrow(
      "Invalid credential length",
    );
    await expect(save(db, "empty", "")).rejects.toThrow("Invalid credential length");
    await expect(save(db, "odd", "line one\nline two with 'quotes' $HOME ;")).resolves.toBe(
      undefined,
    );
    await expect(save(db, "pair", "ok\uD800\uDC00")).resolves.toBeUndefined();
  });

  it("refuses a value an environment variable cannot carry", async () => {
    await expect(save(fakeDatabase(), "nul", "a\0b")).rejects.toThrow(
      "Credential cannot be used with this authentication method",
    );
    await expect(save(fakeDatabase(), "surrogate", "a\uD800b")).rejects.toThrow(
      "Credential cannot be used with this authentication method",
    );
  });

  it("refuses a reserved variable name with a clear message", async () => {
    const db = fakeDatabase();
    await expect(save(db, "ld_preload", "value")).rejects.toThrow(
      /Invalid credential destination — name: \$LD_PRELOAD is reserved/,
    );
    await expect(save(db, "path", "value")).rejects.toThrow(/\$PATH is reserved/);
    expect(db.rows()).toHaveLength(0);
  });

  it("refuses a site for a command variable", async () => {
    await expect(
      save(fakeDatabase(), "token", "value", { origin: "https://api.example.test" }),
    ).rejects.toThrow(/Invalid credential destination — origin/);
  });

  it("replaces the value but keeps the rule that a type change needs remove and re-add", async () => {
    const db = fakeDatabase();
    await save(db, "deploy-token", "first-value");
    await save(db, "deploy-token", "second-value");
    expect(db.rows()).toHaveLength(1);
    expect(secretStore.load(db.rows()[0]!.ciphertext, db.rows()[0]!.id)).toBe("second-value");
    await expect(
      save(db, "deploy-token", "value", {
        origin: "https://api.example.test",
        auth: { type: "bearer" },
      }),
    ).rejects.toThrow("Remove the existing credential before changing its destination");
  });

  it("refuses a second name exported as the same variable", async () => {
    const db = fakeDatabase();
    await save(db, "setup-key", "value-1");
    await expect(save(db, "setup_key", "value-2")).rejects.toThrow(
      /setup-key is already exported as \$SETUP_KEY/,
    );
  });
});

describe("command variables stay out of HTTP and page fills", () => {
  it("refuses secret_request before decrypting or sending", async () => {
    const db = fakeDatabase();
    await save(db, "cli-token", "fake-cli-token-1");
    const fetch = vi.fn<typeof globalThis.fetch>();
    const load = vi.spyOn(secretStore, "load");
    try {
      const result = await requestWithBotSecret({
        prisma: db.prisma,
        secretStore,
        scope,
        request: { name: "cli-token", url: "https://api.example.test/v1" },
        signal: new AbortController().signal,
        remote: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      });
      expect(result).toEqual({
        error: expect.stringMatching(/^Credential cannot be used with this authentication method/),
      });
      expect(JSON.stringify(result)).toContain("$CLI_TOKEN");
      expect(load).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it("refuses browser_act fill_secret", async () => {
    const db = fakeDatabase();
    await save(db, "cli-token", "fake-cli-token-1");
    expect(
      await resolveLoginFill({
        prisma: db.prisma,
        secretStore,
        scope,
        name: "cli-token",
        field: "password",
      }),
    ).toEqual({
      error: expect.stringMatching(/^Credential cannot be used with this authentication method/),
    });
  });
});

describe("list_secrets", () => {
  it("shows a command variable with its variable name and no value", async () => {
    const db = fakeDatabase();
    await save(db, "netbird-setup-key", "fake-setup-key-1");
    await save(db, "api", "fake-bearer-1", {
      origin: "https://api.example.test",
      auth: { type: "bearer" },
    });
    const listed = await listBotSecrets(db.prisma, scope);
    expect(listed).toEqual([
      expect.objectContaining({ name: "api", origin: "https://api.example.test" }),
      { name: "netbird-setup-key", auth: command, variable: "NETBIRD_SETUP_KEY" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("fake-setup-key-1");
  });

  it("reports an invalid stored command name separately from a reserved one", async () => {
    const db = fakeDatabase();
    const longName = "a".repeat(65);
    await db.prisma.botSecret.create({
      data: {
        id: "long-name",
        ...scope,
        name: longName,
        origin: "",
        auth: command,
        ciphertext: "unused",
      },
    });
    await db.prisma.botSecret.create({
      data: {
        id: "reserved-path",
        ...scope,
        name: "path",
        origin: "",
        auth: command,
        ciphertext: "unused",
      },
    });
    const listed = await listBotSecrets(db.prisma, scope);
    expect(listed).toEqual([
      {
        name: longName,
        auth: command,
        error: `$${longName.toUpperCase()} is not a valid environment variable name and is not exported. Remove it and save it under another name.`,
      },
      {
        name: "path",
        auth: command,
        error: "$PATH is reserved and is not exported. Remove it and save it under another name.",
      },
    ]);
  });
});

describe("shell command environment", () => {
  // Mirrors the executor's shell tool: run secrets start with the space variables, each command
  // builds its environment through shellCommandEnvironment, and its output is redacted with them.
  function commandRunner(db: ReturnType<typeof fakeDatabase>, space: Record<string, string>) {
    const runSecrets = [...Object.values(space)];
    const registerRedactions = (values: string[]) => {
      runSecrets.push(...values.filter((value) => !runSecrets.includes(value)));
    };
    return async (runScope = scope) => {
      const env = await shellCommandEnvironment({
        prisma: db.prisma,
        secretStore,
        scope: runScope,
        spaceEnvironment: space,
        registerRedactions,
      });
      // A fake sandbox whose command prints its whole environment.
      const printed = Object.entries(env)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n");
      return {
        env,
        output: redactAgentCommandResult({ stdout: printed, stderr: printed, code: 0 }, runSecrets),
      };
    };
  }

  it("exports the bot's variables over space variables and redacts them from output", async () => {
    const db = fakeDatabase();
    await save(db, "netbird-setup-key", "fake-bot-setup-key");
    const runCommand = commandRunner(db, {
      NETBIRD_SETUP_KEY: "fake-space-setup-key",
      SPACE_ONLY: "fake-space-only",
    });
    const { env, output } = await runCommand();
    expect(env).toEqual({ NETBIRD_SETUP_KEY: "fake-bot-setup-key", SPACE_ONLY: "fake-space-only" });
    expect(output.stdout).toContain("NETBIRD_SETUP_KEY=");
    expect(`${output.stdout}${output.stderr}`).not.toContain("fake-bot-setup-key");
    expect(`${output.stdout}${output.stderr}`).not.toContain("fake-space-only");
  });

  it("does not let one unencodable stored value abort the shell environment", async () => {
    const db = fakeDatabase();
    await save(db, "good-token", "fake-good-token");
    const bad = "pre\uD800post";
    await db.prisma.botSecret.create({
      data: {
        id: "stored-bad",
        userId: scope.userId,
        spaceId: scope.spaceId,
        botId: scope.botId,
        name: "bad-token",
        origin: "",
        auth: command,
        ciphertext: "stored-bad-ciphertext",
      },
    });
    // The cipher's UTF-8 round trip replaces an unpaired surrogate, so this loader
    // stands in for a row whose plaintext still contains one.
    const store = {
      load(ciphertext: string, recordId: string) {
        return recordId === "stored-bad" ? bad : secretStore.load(ciphertext, recordId);
      },
    };
    const redactions: string[] = [];
    const env = await shellCommandEnvironment({
      prisma: db.prisma,
      secretStore: store,
      scope,
      spaceEnvironment: {},
      registerRedactions: (values) => redactions.push(...values),
    });
    expect(env).toEqual({ BAD_TOKEN: bad, GOOD_TOKEN: "fake-good-token" });
    expect(new Set(redactions)).toEqual(
      new Set([
        bad,
        Buffer.from(bad).toString("base64"),
        "fake-good-token",
        Buffer.from("fake-good-token").toString("base64"),
      ]),
    );
  });

  it("redacts encoded command credentials before any shell command registers them", async () => {
    const db = fakeDatabase();
    const value = "fake token/with+chars=";
    await save(db, "api-token", value);
    const environment = await loadBotCommandEnvironment(db.prisma, secretStore, scope);
    const runSecrets = commandCredentialRedactions(environment);
    const forms = [value, Buffer.from(value).toString("base64"), encodeURIComponent(value)];
    const redacted = redactSecrets(forms.join("\n"), runSecrets);
    for (const form of forms) expect(redacted).not.toContain(form);
  });

  it("redacts base64 and URL-encoded forms of a bot variable from command output", async () => {
    const db = fakeDatabase();
    const value = "fake token/with+chars=";
    await save(db, "api-token", value);
    const runSecrets: string[] = [];
    await shellCommandEnvironment({
      prisma: db.prisma,
      secretStore,
      scope,
      spaceEnvironment: {},
      registerRedactions: (values) => runSecrets.push(...values),
    });
    const encoded = [Buffer.from(value).toString("base64"), encodeURIComponent(value)];
    const printed = encoded.join("\n");
    const output = redactAgentCommandResult({ stdout: printed, stderr: "", code: 0 }, runSecrets);
    for (const form of encoded) expect(output.stdout).not.toContain(form);
  });

  it("applies a variable added, replaced, or removed between two commands", async () => {
    const db = fakeDatabase();
    const runCommand = commandRunner(db, {});
    expect((await runCommand()).env).toEqual({});

    await save(db, "later-token", "fake-later-token-1");
    const second = await runCommand();
    expect(second.env).toEqual({ LATER_TOKEN: "fake-later-token-1" });
    expect(second.output.stdout).not.toContain("fake-later-token-1");

    await save(db, "later-token", "fake-later-token-2");
    const third = await runCommand();
    expect(third.env).toEqual({ LATER_TOKEN: "fake-later-token-2" });
    expect(third.output.stdout).not.toContain("fake-later-token-2");

    await forgetBotSecret(db.prisma, scope, "later-token");
    expect((await runCommand()).env).toEqual({});
  });

  it("exports only this bot's command variables", async () => {
    const db = fakeDatabase();
    await save(db, "cli-token", "fake-cli-token-1");
    await save(db, "api", "fake-bearer-1", {
      origin: "https://api.example.test",
      auth: { type: "bearer" },
    });
    await save(db, "other-bot-token", "fake-other-1", {}, { ...scope, botId: "bot-2" });
    expect(await loadBotCommandEnvironment(db.prisma, secretStore, scope)).toEqual({
      CLI_TOKEN: "fake-cli-token-1",
    });
    expect(
      await loadBotCommandEnvironment(db.prisma, secretStore, { ...scope, userId: "user-2" }),
    ).toEqual({});
  });
});
