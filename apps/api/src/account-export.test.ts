import type { AccountExportRecord } from "@rakazo/contracts";
import {
  ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES,
  AccountExportManifestSchema,
  AccountExportRecordSchema,
  accountExportPaths,
} from "@rakazo/contracts";
import type { AccountExportSource } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { Unzip, UnzipInflate } from "fflate";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AccountExportStores } from "./account-export.js";
import { accountArchiveFiles, mountAccountExportRoute, zipStream } from "./account-export.js";

const decoder = new TextDecoder();

/** One pass with the streaming reader, as an import does. */
async function unzipStream(stream: ReadableStream<Uint8Array>) {
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  const unzip = new Unzip((file) => {
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      chunks.push(chunk);
      if (final) entries.push({ name: file.name, data: Buffer.concat(chunks) });
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for await (const chunk of stream) unzip.push(chunk);
  unzip.push(new Uint8Array(0), true);
  return entries;
}

async function* generate<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}

const createdAt = "2026-01-02T03:04:05.000Z";
const botRecord = (id: string): Extract<AccountExportRecord, { type: "bot" }> => ({
  type: "bot",
  id,
  name: "Chief",
  description: "",
  instructions: "Be brief",
  color: "blue",
  avatarSet: "rakazo",
  notifyOnFinish: true,
  pinned: false,
  position: 0,
  sectionId: null,
  archivedAt: null,
  parentBotId: null,
  memoryScope: null,
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  disabledBuiltinTools: [],
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  crossSpaceCommunication: false,
  dailyCheckIns: false,
  fleetManagement: true,
  replyMode: "chat",
  createdAt,
});

function source(): AccountExportSource {
  const space = (
    id: string,
    records: AccountExportRecord[],
    artifacts: string[],
    bots: string[],
  ) => ({
    id,
    name: `Space ${id}`,
    createdAt,
    records: () => generate(records),
    artifacts: () =>
      generate(
        artifacts.map((artifactId) => ({ id: artifactId, storageKey: `key-${artifactId}` })),
      ),
    homes: async () =>
      bots.map((botId) => ({ botId, homeKey: `home-${botId}`, computerScope: "dedicated" })),
  });
  return {
    userId: "user-1",
    user: { name: "Ada", email: "ada@example.test", timezone: null },
    spaces: [
      space(
        "space-a",
        [
          botRecord("bot-1"),
          {
            type: "thread",
            id: "thread-1",
            botId: "bot-1",
            groupId: null,
            historyCompactedUpToSeq: null,
            historyCompactionSummary: null,
            createdAt,
          },
          {
            type: "message",
            id: "message-1",
            threadId: "thread-1",
            seq: 0,
            role: "user",
            blocks: [{ kind: "text", text: "hi" }],
            botId: null,
            replyToMessageId: null,
            replyQuote: null,
            createdAt,
          },
        ],
        ["artifact-1", "artifact-missing"],
        ["bot-1"],
      ),
      space("space-b", [], [], []),
    ],
  };
}

function stores(): AccountExportStores & { contexts: unknown[] } {
  const contexts: unknown[] = [];
  return {
    contexts,
    artifacts: {
      get: vi.fn(async (key: string) => {
        contexts.push(currentDbContext());
        if (key === "key-artifact-missing") throw new Error("not found");
        return new TextEncoder().encode(`bytes of ${key}`);
      }),
    },
    home: {
      exportHome: async function* () {
        contexts.push(currentDbContext());
        yield { path: "notes/todo.md", content: new TextEncoder().encode("ship it") };
        yield { path: "empty.txt", content: new Uint8Array(0) };
      },
    },
  };
}

describe("account export archive", () => {
  it("preserves the check-in opt-out and defaults older archives to on", () => {
    expect(AccountExportRecordSchema.parse(botRecord("bot-1"))).toMatchObject({
      dailyCheckIns: false,
    });
    const { dailyCheckIns: _dailyCheckIns, ...olderRecord } = botRecord("bot-1");
    expect(AccountExportRecordSchema.parse(olderRecord)).toMatchObject({ dailyCheckIns: true });
  });

  it("streams manifest, then each space's records, artifacts and homes", async () => {
    const fakes = stores();
    const entries = await unzipStream(
      zipStream(accountArchiveFiles(source(), fakes, { now: new Date(createdAt) })),
    );
    expect(entries.map((entry) => entry.name)).toEqual([
      "manifest.json",
      accountExportPaths.records("space-a"),
      accountExportPaths.artifact("space-a", "artifact-1"),
      accountExportPaths.homeFile("space-a", "bot-1", "notes/todo.md"),
      accountExportPaths.homeFile("space-a", "bot-1", "empty.txt"),
      accountExportPaths.records("space-b"),
    ]);
    const manifest = AccountExportManifestSchema.parse(
      JSON.parse(decoder.decode(entries[0]!.data)),
    );
    expect(manifest).toMatchObject({
      exportedAt: createdAt,
      user: { name: "Ada", email: "ada@example.test" },
      spaces: [{ id: "space-a" }, { id: "space-b" }],
    });
    const lines = decoder.decode(entries[1]!.data).trimEnd().split("\n");
    expect(lines.map((line) => AccountExportRecordSchema.parse(JSON.parse(line)).type)).toEqual([
      "bot",
      "thread",
      "message",
    ]);
    expect(decoder.decode(entries[2]!.data)).toBe("bytes of key-artifact-1");
    expect(decoder.decode(entries[3]!.data)).toBe("ship it");
    expect(entries[4]!.data).toHaveLength(0);
    expect(entries[5]!.data).toHaveLength(0);
    expect(fakes.contexts).toEqual(
      Array(3).fill({ kind: "tenant", spaceId: "space-a", userId: "user-1" }),
    );
  });

  it("yields the encrypted credentials section right after the manifest", async () => {
    const fakes = stores();
    const credentialsFile = new TextEncoder().encode('{"algorithm":"aes-256-gcm"}');
    const entries = await unzipStream(
      zipStream(
        accountArchiveFiles(source(), fakes, { now: new Date(createdAt), credentialsFile }),
      ),
    );
    expect(entries.map((entry) => entry.name).slice(0, 2)).toEqual([
      "manifest.json",
      "credentials.enc.json",
    ]);
    expect(entries[1]!.data).toEqual(Buffer.from(credentialsFile));
    const without = await unzipStream(
      zipStream(accountArchiveFiles(source(), fakes, { now: new Date(createdAt) })),
    );
    expect(without.map((entry) => entry.name)).not.toContain("credentials.enc.json");
  });

  it("leaves out workspace files over the import limit", async () => {
    const fakes = stores();
    fakes.home.exportHome = async function* () {
      yield { path: "big.bin", content: new Uint8Array(ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES + 1) };
      yield { path: "small.txt", content: new TextEncoder().encode("kept") };
    };
    const entries = await unzipStream(zipStream(accountArchiveFiles(source(), fakes)));
    expect(entries.map((entry) => entry.name)).toContain(
      accountExportPaths.homeFile("space-a", "bot-1", "small.txt"),
    );
    expect(entries.map((entry) => entry.name)).not.toContain(
      accountExportPaths.homeFile("space-a", "bot-1", "big.bin"),
    );
  });

  it("lists executable workspace files after them", async () => {
    const fakes = stores();
    fakes.home.exportHome = async function* () {
      yield { path: "run.sh", content: new TextEncoder().encode("echo hi"), executable: true };
      yield { path: "notes.md", content: new TextEncoder().encode("plain") };
    };
    const entries = await unzipStream(zipStream(accountArchiveFiles(source(), fakes)));
    const names = entries.map((entry) => entry.name);
    const listed = names.indexOf(accountExportPaths.executables("space-a"));
    expect(listed).toBeGreaterThan(
      names.indexOf(accountExportPaths.homeFile("space-a", "bot-1", "notes.md")),
    );
    expect(JSON.parse(decoder.decode(entries[listed]!.data))).toEqual([
      { botId: "bot-1", path: "run.sh" },
    ]);
    expect(names).not.toContain(accountExportPaths.executables("space-b"));
  });

  it("compresses files that start with zero bytes into data that reads back", async () => {
    // Leading zeros (fonts, many binary formats) let unpatched streaming deflate refer back
    // into its empty window, which every inflater rejects as an invalid distance.
    const content = new Uint8Array(4 + 2048);
    for (let i = 4; i < content.length; i++) content[i] = i % 37 < 8 ? (i * 11) & 0xff : 0;
    const entries = await unzipStream(zipStream(generate([{ path: "font.ttf", data: [content] }])));
    expect(entries).toEqual([{ name: "font.ttf", data: Buffer.from(content) }]);
  });

  it("fails instead of writing an archive past the zip size limit", async () => {
    const reader = zipStream(accountArchiveFiles(source(), stores()), 200).getReader();
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return;
      })(),
    ).rejects.toThrow("zip size limit");
  });

  it("reads only as fast as it is consumed, and stops when cancelled", async () => {
    let produced = 0;
    let stopped = false;
    async function* endless(): AsyncGenerator<AccountExportRecord> {
      try {
        for (;;) {
          produced += 1;
          yield {
            ...botRecord(`bot-${produced}`),
            instructions: Math.random().toString(36).repeat(50),
          };
        }
      } finally {
        stopped = true;
      }
    }
    const archive = source();
    archive.spaces[0]!.records = endless;
    const reader = zipStream(accountArchiveFiles(archive, stores())).getReader();
    while (produced === 0) expect((await reader.read()).done).toBe(false);
    const afterReads = produced;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(produced).toBe(afterReads);
    await reader.cancel();
    expect(stopped).toBe(true);
  });
});

describe("POST /api/account/export", () => {
  const fakePrisma = () => ({
    user: {
      findUnique: async () => ({ deactivatedAt: null }),
      findUniqueOrThrow: async () => ({ name: "Ada", email: "ada@example.com", timezone: null }),
    },
    spaceMember: { findMany: async () => [] },
    secret: { findFirst: async () => ({ ciphertext: "enc:sec-1" }) },
    userModelCredential: {
      findMany: async () => [
        { provider: "acme", label: "Acme", secretId: "sec-1", supportsImages: false },
      ],
    },
    userVoiceCredential: { findMany: async () => [] },
    connection: { findMany: async () => [] },
    mcpServer: { findMany: async () => [] },
    vaultCredential: { findMany: async () => [] },
    botSecret: { findMany: async () => [] },
  });
  const fakeAuth = (overrides: Record<string, unknown> = {}) => ({
    consumeAccountExportToken: vi.fn(async (token: string) => (token === "used" ? "user-1" : null)),
    verifyAccountPassword: vi.fn(async () => false),
    isPasswordBreached: vi.fn(async () => false),
    ...overrides,
  });
  const fakeSecrets = {
    load: vi.fn(async () => "sk-acme"),
    put: vi.fn(),
  };
  const postExport = (app: Hono, body: unknown) =>
    app.request("/api/account/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const mount = (authOverrides: Record<string, unknown> = {}) => {
    const app = new Hono();
    mountAccountExportRoute(app, {
      ...stores(),
      prisma: fakePrisma() as never,
      secrets: fakeSecrets as never,
      auth: fakeAuth(authOverrides),
    });
    return app;
  };

  it("refuses a token that does not name a user", async () => {
    const app = mount();
    const response = await postExport(app, { token: "nope" });
    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts the token as `token` or `accountToken`", async () => {
    for (const body of [{ token: "used" }, { accountToken: "used" }]) {
      expect((await postExport(mount(), body)).status).toBe(200);
    }
  });

  it("exports without a credentials section when no backup password is sent", async () => {
    const entries = await unzipStream((await postExport(mount(), { token: "used" })).body!);
    expect(entries.map((entry) => entry.name)).toEqual(["manifest.json"]);
    expect(fakeSecrets.load).not.toHaveBeenCalled();
  });

  it("seals credentials with the backup password and keeps the password out of the zip", async () => {
    const backupPassword = "correct horse battery staple";
    const response = await postExport(mount(), { token: "used", backupPassword });
    expect(response.status).toBe(200);
    const entries = await unzipStream(response.body!);
    expect(entries.map((entry) => entry.name)).toEqual(["manifest.json", "credentials.enc.json"]);
    const whole = Buffer.concat(entries.map((entry) => entry.data));
    expect(whole.includes(backupPassword)).toBe(false);
    expect(whole.includes("sk-acme")).toBe(false);
    const { decryptBackupCredentials } = await import("./account-credentials-crypto.js");
    const credentials = await decryptBackupCredentials({
      userId: "user-1",
      password: Buffer.from(backupPassword, "utf8"),
      encrypted: JSON.parse(new TextDecoder().decode(entries[1]!.data)),
    });
    expect(credentials.model).toEqual([
      { provider: "acme", label: "Acme", supportsImages: false, plaintext: "sk-acme" },
    ]);
  });

  it("refuses a short backup password", async () => {
    const response = await postExport(mount(), { token: "used", backupPassword: "short" });
    expect(response.status).toBe(400);
  });

  it("refuses a backup password equal to the account password", async () => {
    const app = mount({ verifyAccountPassword: async () => true });
    const response = await postExport(app, {
      token: "used",
      backupPassword: "correct horse battery staple",
    });
    expect(response.status).toBe(400);
  });

  it("refuses a breached backup password", async () => {
    const app = mount({ isPasswordBreached: async () => true });
    const response = await postExport(app, {
      token: "used",
      backupPassword: "correct horse battery staple",
    });
    expect(response.status).toBe(400);
  });
});
