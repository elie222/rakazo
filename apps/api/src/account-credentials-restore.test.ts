import type { AccountExportCredentials, Actor } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { encryptBackupCredentials } from "./account-credentials-crypto.js";
import type { CredentialMappings } from "./account-credentials-restore.js";
import { restoreAccountCredentials } from "./account-credentials-restore.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-new",
  email: "ada@example.com",
  isDeploymentOwner: false,
};

const password = Buffer.from("correct horse battery staple", "utf8");

type Row = Record<string, unknown>;

/** In-memory stand-in for the Prisma delegates the restore touches. */
function fakePrisma() {
  const tables: {
    secret: Row[];
    userModelCredential: Row[];
    userVoiceCredential: Row[];
    connection: Row[];
    mcpServer: Row[];
    vaultCredential: Row[];
    botSecret: Row[];
  } = {
    secret: [],
    userModelCredential: [],
    userVoiceCredential: [],
    connection: [],
    mcpServer: [],
    vaultCredential: [],
    botSecret: [],
  };
  const matches = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && "in" in (value as Row))
        return ((value as Row).in as unknown[]).includes(row[key]);
      return row[key] === value;
    });
  };
  const delegate = (table: keyof typeof tables) => ({
    findFirst: async ({ where }: { where?: Row }) =>
      tables[table].find((row) => matches(row, where)) ?? null,
    findMany: async ({ where }: { where?: Row }) =>
      tables[table].filter((row) => matches(row, where)),
    create: async ({ data }: { data: Row }) => {
      const row = { id: `row-${tables[table].length}`, ...data };
      tables[table].push(row);
      return row;
    },
  });
  const tx = {
    secret: delegate("secret"),
    userModelCredential: delegate("userModelCredential"),
    userVoiceCredential: delegate("userVoiceCredential"),
    connection: delegate("connection"),
    mcpServer: delegate("mcpServer"),
    vaultCredential: delegate("vaultCredential"),
    botSecret: delegate("botSecret"),
  };
  const prisma = {
    ...tx,
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  return { prisma, tables };
}

function fakeSecrets() {
  const saved = new Map<string, string>();
  return {
    saved,
    put: async (plaintext: string, _context: unknown, options?: { recordId?: string }) => {
      const id = options?.recordId ?? `secret-${saved.size}`;
      saved.set(id, plaintext);
      return { id, ref: `enc:${id}`, ciphertext: `enc:${id}` };
    },
  };
}

const credentials: AccountExportCredentials = {
  version: 1,
  model: [{ provider: "acme", label: "Acme", supportsImages: true, plaintext: "sk-acme" }],
  voice: [{ provider: "voice-co", plaintext: "voice-key" }],
  connections: [
    {
      spaceId: "space-old",
      connectorId: "composio",
      provider: "github",
      displayName: "GitHub",
      status: "connected",
      providerRef: "acct-1",
      metadata: {},
      plaintext: "oauth-token",
    },
  ],
  mcp: [
    {
      spaceId: "space-old",
      slug: "tools",
      name: "Tools",
      description: "",
      transport: "http",
      endpoint: "https://mcp.example.test",
      command: null,
      allSpaces: false,
      allBots: false,
      enabled: true,
      verbatimResults: false,
      material: { headers: { Authorization: "Bearer mcp-token" }, env: {} },
    },
  ],
  vault: [
    {
      spaceId: null,
      name: "login",
      title: "Login",
      note: "",
      origin: "https://example.test",
      auth: { type: "login" },
      plaintext: "user:pass",
    },
  ],
  botSecrets: [
    {
      spaceId: "space-old",
      botId: "bot-old",
      name: "api-key",
      origin: "",
      auth: { type: "api_key" },
      plaintext: "bot-key",
    },
  ],
};

const mappings: CredentialMappings = {
  spaces: new Map([["space-old", "space-new"]]),
  bots: new Map([["bot-old", "bot-new"]]),
};

async function encrypted(passwordBuffer: Buffer) {
  return encryptBackupCredentials({ userId: actor.userId, password: passwordBuffer, credentials });
}

describe("credential restore", () => {
  it("restores every table, then skips the same rows on a second restore", async () => {
    const { prisma, tables } = fakePrisma();
    const secrets = fakeSecrets();
    const file = await encrypted(password);
    const first = await restoreAccountCredentials(
      { prisma: prisma as never, secrets: secrets as never },
      actor,
      file,
      Buffer.from(password),
      mappings,
    );
    expect(first?.error).toBeUndefined();
    expect(first?.restored).toEqual({
      model: 1,
      voice: 1,
      connections: 1,
      mcp: 1,
      vault: 1,
      botSecrets: 1,
    });
    expect(tables.userModelCredential).toHaveLength(1);
    expect(tables.userModelCredential[0]).toMatchObject({ provider: "acme", label: "Acme" });
    expect(tables.userVoiceCredential).toHaveLength(1);
    expect(tables.connection[0]).toMatchObject({ spaceId: "space-new", status: "connected" });
    expect(tables.mcpServer[0]).toMatchObject({ spaceId: "space-new", slug: "tools" });
    expect(tables.vaultCredential[0]).toMatchObject({ spaceId: null, name: "login" });
    expect(tables.botSecret[0]).toMatchObject({ spaceId: "space-new", botId: "bot-new" });
    // Every sealed value round-trips through the fake store.
    const values = [...secrets.saved.values()];
    expect(values).toContain("sk-acme");
    expect(values).toContain("voice-key");
    expect(values).toContain("oauth-token");
    expect(values).toContain("user:pass");
    expect(values).toContain("bot-key");
    expect(values.some((value) => value.includes("mcp-token"))).toBe(true);

    const second = await restoreAccountCredentials(
      { prisma: prisma as never, secrets: secrets as never },
      actor,
      file,
      Buffer.from(password),
      mappings,
    );
    expect(second?.restored).toEqual({
      model: 0,
      voice: 0,
      connections: 0,
      mcp: 0,
      vault: 0,
      botSecrets: 0,
    });
    expect(second?.skipped).toEqual({
      model: 1,
      voice: 1,
      connections: 1,
      mcp: 1,
      vault: 1,
      botSecrets: 1,
    });
    expect(tables.userModelCredential).toHaveLength(1);
  });

  it("reports a wrong password and writes nothing", async () => {
    const { prisma, tables } = fakePrisma();
    const secrets = fakeSecrets();
    const file = await encrypted(password);
    const result = await restoreAccountCredentials(
      { prisma: prisma as never, secrets: secrets as never },
      actor,
      file,
      Buffer.from("wrong password here", "utf8"),
      mappings,
    );
    expect(result?.error).toMatch("backup password is incorrect");
    expect(result?.restored).toEqual({
      model: 0,
      voice: 0,
      connections: 0,
      mcp: 0,
      vault: 0,
      botSecrets: 0,
    });
    expect(Object.values(tables).flat()).toHaveLength(0);
    expect(secrets.saved.size).toBe(0);
  });

  it("reports a missing password and writes nothing", async () => {
    const { prisma, tables } = fakePrisma();
    const result = await restoreAccountCredentials(
      { prisma: prisma as never, secrets: fakeSecrets() as never },
      actor,
      await encrypted(password),
      null,
      mappings,
    );
    expect(result?.error).toMatch("backup password is required");
    expect(Object.values(tables).flat()).toHaveLength(0);
  });

  it("skips rows whose space or bot was not imported", async () => {
    const { prisma, tables } = fakePrisma();
    const secrets = fakeSecrets();
    const empty: CredentialMappings = { spaces: new Map(), bots: new Map() };
    const result = await restoreAccountCredentials(
      { prisma: prisma as never, secrets: secrets as never },
      actor,
      await encrypted(password),
      Buffer.from(password),
      empty,
    );
    // Model and voice are account-wide, so they still restore.
    expect(result?.restored).toMatchObject({ model: 1, voice: 1 });
    expect(result?.skipped).toMatchObject({
      connections: 1,
      mcp: 1,
      vault: 0,
      botSecrets: 1,
    });
    expect(tables.botSecret).toHaveLength(0);
  });
});
