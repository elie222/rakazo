import { redactSecrets } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { redactShellStreams } from "./agent-environment.js";
import { commandCredentialRedactions } from "./bot-secrets.js";
import {
  activeCloudAgentBinding,
  CloudAgentCredentialBusy,
  cloudAgentCallerForStored,
  cloudAgentCliOnComputer,
  cloudAgentCredentialStatus,
  cloudAgentToolsEnabled,
  connectCloudAgentCredential,
  disconnectCloudAgentCredential,
} from "./cloud-agent-credentials.js";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { cloudAgentProviderKey } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { listAgentSkillRecords } from "./skill-tools.js";

const SECRET = "cursor-user-secret";
const USER_HASH = cloudAgentProviderKey(SECRET);
const DEPLOY_HASH = cloudAgentProviderKey("deploy-secret");

function connection(overrides: Partial<CloudAgentConnection> = {}): CloudAgentConnection {
  return {
    key: DEPLOY_HASH,
    spaceId: "deploy-space",
    provider: {
      describe: () => ({ id: "cursor", capabilities: { offline: false } }),
      launch: vi.fn(),
      get: vi.fn(),
      reply: vi.fn(),
      cancel: vi.fn(),
    } as unknown as CloudAgentConnection["provider"],
    userCredentialProviderId: "cursor",
    displayName: "Cursor",
    ...overrides,
  };
}

function store(options?: { openAgents?: number; row?: boolean }) {
  const secrets = new Map<string, string>();
  let row =
    options?.row === false
      ? null
      : {
          id: "cloud-agent-credential:user-1",
          userId: "user-1",
          provider: "cursor",
          providerKey: USER_HASH,
          ciphertext: "sealed-user-key",
          updatedAt: new Date("2026-11-03T00:00:00.000Z"),
        };
  secrets.set("sealed-user-key", JSON.stringify({ secret: SECRET }));
  const loads: string[] = [];
  const prisma = {
    cloudAgentCredential: {
      findUnique: vi.fn(async () => row),
      findMany: vi.fn(async () => (row ? [{ providerKey: row.providerKey }] : [])),
      upsert: vi.fn(async ({ create }: { create: typeof row }) => {
        row = { ...create!, updatedAt: new Date("2026-11-03T00:00:00.000Z") };
        return row;
      }),
      deleteMany: vi.fn(async () => {
        const count = row ? 1 : 0;
        row = null;
        return { count };
      }),
    },
    cloudAgent: {
      count: vi.fn(async () => options?.openAgents ?? 0),
      findFirst: vi.fn(async () => ({
        id: "agent-1",
        nextPollAt: new Date(),
        providerKey: "cursor:someone-else",
        spaceId: "other-space",
        userId: "user-1",
        version: 0,
      })),
      updateMany: vi.fn(),
    },
    agentSkill: { findMany: vi.fn(async () => []) },
  };
  const secretStore = {
    put: vi.fn(async (plaintext: string) => {
      const ref = `sealed-${secrets.size}`;
      secrets.set(ref, plaintext);
      return { id: ref, ref, ciphertext: ref };
    }),
    load: vi.fn(async (ref: string) => {
      loads.push(ref);
      const value = secrets.get(ref);
      if (!value) throw new Error("missing");
      return value;
    }),
    delete: vi.fn(async () => undefined),
  };
  return {
    prisma,
    secretStore,
    loads,
    get row() {
      return row;
    },
  };
}

const actor = { userId: "user-1", spaceId: "other-space" };

describe("cloud agent user keys", () => {
  it("lets a saved key enable tools outside the deployment space", async () => {
    const { prisma } = store();
    const bound = connection();
    await expect(
      cloudAgentToolsEnabled(prisma as never, bound, "user-1", "other-space"),
    ).resolves.toBe(true);
    await expect(
      activeCloudAgentBinding(
        { prisma: prisma as never, cloudAgent: bound },
        "user-1",
        "deploy-space",
      ),
    ).resolves.toEqual({ providerKey: USER_HASH });
  });

  it("keeps the deployment key inside its space when the user has none", async () => {
    const { prisma } = store({ row: false });
    const bound = connection();
    await expect(
      cloudAgentToolsEnabled(prisma as never, bound, "user-1", "other-space"),
    ).resolves.toBe(false);
    await expect(
      cloudAgentToolsEnabled(prisma as never, bound, "user-1", "deploy-space"),
    ).resolves.toBe(true);
    await expect(
      activeCloudAgentBinding(
        { prisma: prisma as never, cloudAgent: bound },
        "user-1",
        "deploy-space",
      ),
    ).resolves.toEqual({ providerKey: DEPLOY_HASH });
  });

  it("makes no provider call when the stored hash matches neither key", async () => {
    const { prisma, secretStore, loads } = store();
    const get = vi.fn();
    const bound = connection();
    bound.provider = { ...bound.provider!, get };
    await expect(
      cloudAgentCallerForStored(
        { prisma: prisma as never, secretStore, cloudAgent: bound },
        { userId: "user-1", spaceId: "other-space", providerKey: "cursor:someone-else" },
      ),
    ).resolves.toBeNull();
    expect(loads).toEqual([]);
    await pollCloudAgent(
      {
        prisma: prisma as never,
        jobs: {
          enqueue: async () => undefined,
          cancel: async () => undefined,
          close: async () => undefined,
        },
        events: { notify: async () => undefined },
        cloudAgent: bound,
        secretStore,
      },
      { agentId: "agent-1" },
    );
    expect(get).not.toHaveBeenCalled();
    expect(prisma.cloudAgent.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to replace or disconnect the key while an agent is still open", async () => {
    const replaced = store({ openAgents: 1 });
    const replacing = {
      prisma: replaced.prisma as never,
      secretStore: replaced.secretStore,
      cloudAgent: connection(),
    };
    await expect(
      connectCloudAgentCredential(replacing, actor, "a-different-key"),
    ).rejects.toBeInstanceOf(CloudAgentCredentialBusy);
    expect(replaced.secretStore.put).not.toHaveBeenCalled();
    const kept = store({ openAgents: 1 });
    const sameKey = {
      prisma: kept.prisma as never,
      secretStore: kept.secretStore,
      cloudAgent: connection(),
    };
    await expect(connectCloudAgentCredential(sameKey, actor, SECRET)).resolves.toMatchObject({
      status: "connected",
    });
    await expect(disconnectCloudAgentCredential(sameKey, actor)).rejects.toBeInstanceOf(
      CloudAgentCredentialBusy,
    );
    expect(kept.prisma.cloudAgentCredential.deleteMany).not.toHaveBeenCalled();
  });

  it("never returns the key from status, connect, or a command transcript", async () => {
    const { prisma, secretStore } = store();
    const deps = { prisma: prisma as never, secretStore, cloudAgent: connection() };
    const status = await cloudAgentCredentialStatus(deps, actor);
    expect(status).toEqual({ status: "connected", connectedAt: "2026-11-03T00:00:00.000Z" });
    expect(JSON.stringify(status)).not.toContain(SECRET);
    const connected = await connectCloudAgentCredential(deps, actor, `  ${SECRET}  `);
    expect(JSON.stringify(connected)).not.toContain(SECRET);
    const redacted = redactShellStreams(
      { stdout: `using ${SECRET}`, stderr: "" },
      commandCredentialRedactions({ CURSOR_API_KEY: SECRET }),
    );
    expect(redacted.stdout).toBe("using [redacted]");
    expect(
      redactSecrets(SECRET, commandCredentialRedactions({ CURSOR_API_KEY: SECRET })),
    ).not.toContain(SECRET);
  });

  it("lists the computer CLI skill only for a user who saved a key", async () => {
    const saved = store();
    const hidden = store({ row: false });
    const options = { cloudAgentProviderId: "cursor" };
    const shown = await listAgentSkillRecords(saved.prisma as never, actor, options);
    const absent = await listAgentSkillRecords(hidden.prisma as never, actor, options);
    expect(shown.some((skill) => skill.name === "Cursor" && skill.description.length <= 72)).toBe(
      true,
    );
    expect(JSON.stringify(shown)).not.toContain(SECRET);
    expect(absent.some((skill) => skill.name === "Cursor")).toBe(false);
  });

  it("keeps the CLI key off Windows computers, including a desktop whose platform is unknown", () => {
    expect(cloudAgentCliOnComputer({ kind: "docker", platform: undefined })).toBe(true);
    expect(cloudAgentCliOnComputer({ kind: "desktop", platform: "darwin" })).toBe(true);
    expect(cloudAgentCliOnComputer({ kind: "desktop", platform: "linux" })).toBe(true);
    expect(cloudAgentCliOnComputer({ kind: "desktop", platform: "win32" })).toBe(false);
    expect(cloudAgentCliOnComputer({ kind: "desktop", platform: undefined })).toBe(false);
    expect(cloudAgentCliOnComputer({ kind: "wuying", platform: "linux" })).toBe(false);
  });
});
