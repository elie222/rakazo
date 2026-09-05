import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob, runJobKey } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import {
  WorkforceConfigure,
  WorkforceReport,
  WorkforceSync,
  WorkforceSyncResult,
} from "@rakazo/contracts";
import {
  createRepos,
  type Pool,
  type PrismaClient,
  requireMembership,
  type ThreadEvents,
} from "@rakazo/db";
import * as z from "zod";
import type { EncryptedSecretStore } from "./secrets.js";

const StoredWorker = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  instructions: z.string().default(""),
});
const terminal = new Set(["completed", "failed", "cancelled"]);
export function companyOsEndpoint(
  value: string,
  allowed = process.env.COMPANY_OS_ALLOWED_ORIGINS ?? "https://www.companyos.sh",
) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== "/api/mcp" ||
    !allowed
      .split(",")
      .map((s) => s.trim())
      .includes(url.origin)
  )
    throw new Error("Company OS endpoint is not allowed by this deployment");
  return url.toString();
}
export interface WorkforcePeer {
  sync(input: z.infer<typeof WorkforceSync>): Promise<z.infer<typeof WorkforceSyncResult>>;
  tools(): Promise<string[]>;
  close(): Promise<void>;
}
export async function connectCompanyOs(endpoint: string, key: string): Promise<WorkforcePeer> {
  const client = new Client({ name: "cadre-workforce", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(companyOsEndpoint(endpoint)), {
    requestInit: { headers: { Authorization: `Bearer ${key}` }, redirect: "error" },
  });
  try {
    await client.connect(transport, { timeout: 15000 });
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return {
    async sync(input) {
      const result = await client.callTool(
        { name: "workforce_sync", arguments: WorkforceSync.parse(input) },
        undefined,
        { timeout: 20000 },
      );
      if (result.isError)
        throw new Error(
          "Company OS refused workforce sync; check key authority and protocol version",
        );
      const content = result.content as Array<{ type: string; text?: string }> | undefined;
      const raw =
        result.structuredContent ??
        JSON.parse(
          content
            ?.filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n") ?? "null",
        );
      return WorkforceSyncResult.parse(raw);
    },
    async tools() {
      return (await client.listTools({}, { timeout: 15000 })).tools.map((t) => t.name);
    },
    close: () => client.close(),
  };
}
export interface WorkforceDeps {
  prisma: PrismaClient;
  pool?: Pool;
  secrets: EncryptedSecretStore;
  events: ThreadEvents;
  jobs: JobPublisher;
  connect?: typeof connectCompanyOs;
}
export function createCompanyOsWorkforce(deps: WorkforceDeps) {
  const { prisma, pool, secrets, events, jobs } = deps;
  const connect = deps.connect ?? connectCompanyOs;
  const context = (actor: Pick<Actor, "spaceId" | "userId">): AdapterContext => ({
    ...actor,
    operationId: "workforce",
    traceId: "workforce",
    signal: AbortSignal.timeout(30000),
  });
  const publicConnection = (row: {
    id: string;
    endpoint: string;
    enabled: boolean;
    companyName: string;
    companySlug: string;
    workers: unknown;
    lastSyncedAt: Date | null;
    lastError: string | null;
  }) => ({
    id: row.id,
    endpoint: row.endpoint,
    enabled: row.enabled,
    companyName: row.companyName,
    companySlug: row.companySlug,
    workers: row.workers,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
  });
  async function locked<T>(key: string, action: () => Promise<T>): Promise<T | null> {
    if (!pool) throw new Error("Workforce requires a PostgreSQL connection pool");
    const lock = await pool.connect();
    try {
      const result = await lock.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [`cadre-workforce:${key}`],
      );
      if (!result.rows[0].locked) return null;
      try {
        return await action();
      } finally {
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
          `cadre-workforce:${key}`,
        ]);
      }
    } finally {
      lock.release();
    }
  }
  async function configure(actor: Actor, raw: unknown) {
    const input = WorkforceConfigure.parse(raw);
    const endpoint = companyOsEndpoint(input.endpoint);
    const output = await locked(`${actor.spaceId}:${actor.userId}`, async () => {
      const existing = await prisma.workforceConnection.findUnique({
        where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
      });
      const id = existing?.id ?? randomUUID();
      if (existing && existing.endpoint !== endpoint)
        throw new Error("Pause and finish existing work before changing the Company OS endpoint");
      const key = input.key ?? (existing ? secrets.load(existing.credential, id) : "");
      if (!key) throw new Error("A Company OS agent key is required");
      const peer = await connect(endpoint, key);
      try {
        // A paused handshake verifies company identity and protocol without claiming work.
        const pending = await prisma.workforceAssignment.count({
          where: { connectionId: id, acknowledged: false },
        });
        if (pending)
          throw new Error(
            "Pause dispatch and finish active assignments before reconfiguring the workforce",
          );
        const identity = await peer.sync({
          installationId: id,
          enabled: false,
          workers: [],
          reports: [],
        });
        if (existing && existing.companySlug !== identity.company.slug)
          throw new Error("This key belongs to a different Company OS company");
        const allowedTools = (await peer.tools()).filter(
          (name) => !name.startsWith("work_") && !name.startsWith("workforce_"),
        );
        const encrypted = await secrets.put(key, context(actor), id);
        const mcpSecret = await secrets.put(JSON.stringify({ secret: key }), context(actor));
        const server = await prisma.$transaction(async (tx) => {
          await tx.secret.create({
            data: {
              id: mcpSecret.id,
              ciphertext: mcpSecret.ciphertext,
              kind: "mcp",
              userId: actor.userId,
              spaceId: actor.spaceId,
            },
          });
          return tx.mcpServer.upsert({
            where: {
              spaceId_userId_slug: {
                spaceId: actor.spaceId,
                userId: actor.userId,
                slug: "company-os-workforce",
              },
            },
            create: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              slug: "company-os-workforce",
              name: "Company OS",
              transport: "streamable_http",
              endpoint,
              secretId: mcpSecret.id,
            },
            update: { endpoint, secretId: mcpSecret.id, revision: { increment: 1 }, enabled: true },
          });
        });
        const previous = existing ? z.array(StoredWorker).parse(existing.workers) : [];
        const workers: z.infer<typeof StoredWorker>[] = [];
        for (const [index, worker] of input.workers.entries()) {
          const spawnKey = `workforce:${id}:${index}`;
          let bot = await prisma.bot.findUnique({
            where: { spaceId_spawnKey: { spaceId: actor.spaceId, spawnKey } },
          });
          const instructions = `${worker.instructions}\nYou are a member of a managed labor force. Complete only the assigned request. Use the Company OS connector to read context and save deliverables on a working branch. Ask for input or approval when needed. Report actual outcomes and document references. The dispatcher owns queue claims and completion.`;
          if (!bot) {
            const created = await createRepos(prisma).createBot(actor, {
              name: worker.name,
              title: "Company OS worker",
              description: "",
              instructions,
              notifyOnFinish: true,
              modelProvider: "openrouter",
              modelId: worker.model,
              computerMode: "dedicated",
              spawnKey,
            });
            bot = await prisma.bot.findUniqueOrThrow({ where: { id: created.id } });
          } else {
            bot = await prisma.bot.update({
              where: { id: bot.id },
              data: {
                name: worker.name,
                instructions,
                modelProvider: "openrouter",
                modelId: worker.model,
                archivedAt: null,
              },
            });
          }
          await prisma.botMcpServer.upsert({
            where: { botId_serverId: { botId: bot.id, serverId: server.id } },
            create: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: bot.id,
              serverId: server.id,
              allowAllTools: false,
              allowedTools,
            },
            update: { allowAllTools: false, allowedTools },
          });
          workers.push({
            id: bot.id,
            name: worker.name,
            model: worker.model,
            instructions: worker.instructions,
          });
        }
        for (const old of previous.filter((w) => !workers.some((n) => n.id === w.id)))
          await prisma.bot.updateMany({
            where: { id: old.id, spaceId: actor.spaceId, userId: actor.userId },
            data: { archivedAt: new Date() },
          });
        const data = {
          endpoint,
          credential: encrypted.ciphertext,
          companyName: identity.company.name,
          companySlug: identity.company.slug,
          workers,
          enabled: input.enabled,
          lastError: null,
        };
        const row = await prisma.workforceConnection.upsert({
          where: { id },
          create: { id, spaceId: actor.spaceId, userId: actor.userId, ...data },
          update: data,
        });
        return publicConnection(row);
      } finally {
        await peer.close();
      }
    });
    if (!output) throw new Error("Workforce sync is in progress; try again");
    return output;
  }
  async function tickConnection(id: string) {
    const row = await prisma.workforceConnection.findUnique({ where: { id } });
    if (!row) return;
    await locked(`${row.spaceId}:${row.userId}`, async () => {
      const current = await prisma.workforceConnection.findUniqueOrThrow({ where: { id } });
      let peer: WorkforcePeer | undefined;
      try {
        await requireMembership(prisma, current.userId, current.spaceId);
        const workers = z.array(StoredWorker).parse(current.workers);
        const assignments = await prisma.workforceAssignment.findMany({
          where: { connectionId: id, acknowledged: false },
          take: 100,
        });
        const reports: z.infer<typeof WorkforceReport>[] = [];
        for (const assignment of assignments) {
          if (!assignment.runId) continue;
          const run = await prisma.run.findFirst({
            where: { id: assignment.runId, spaceId: current.spaceId, userId: current.userId },
          });
          if (!run) {
            reports.push({
              dispatchId: assignment.dispatchId,
              status: "failed",
              summary: "Run is no longer available",
            });
            continue;
          }
          const status =
            run.status === "leased" ? "running" : WorkforceReport.shape.status.parse(run.status);
          let summary: string | undefined;
          if (status === "completed") {
            const message = await prisma.message.findFirst({
              where: { runId: run.id, role: "bot" },
              orderBy: { seq: "desc" },
            });
            const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
            summary = blocks
              .flatMap((b) =>
                b &&
                typeof b === "object" &&
                "kind" in b &&
                b.kind === "text" &&
                "text" in b &&
                typeof b.text === "string"
                  ? [b.text]
                  : [],
              )
              .join("\n")
              .slice(0, 4000)
              .trim();
            if (!summary) {
              reports.push({
                dispatchId: assignment.dispatchId,
                runId: run.id,
                status: "failed",
                summary: "Run completed without a result summary",
              });
              continue;
            }
          }
          reports.push({
            dispatchId: assignment.dispatchId,
            runId: run.id,
            status,
            ...(summary ? { summary } : {}),
          });
        }
        const activeBots = await prisma.bot.findMany({
          where: {
            id: { in: workers.map((w) => w.id) },
            spaceId: current.spaceId,
            userId: current.userId,
            archivedAt: null,
          },
          select: { id: true },
        });
        const busy = await prisma.run.findMany({
          where: { botId: { in: workers.map((w) => w.id) }, status: { notIn: [...terminal] } },
          select: { botId: true },
        });
        peer = await connect(current.endpoint, secrets.load(current.credential, id));
        const result = await peer.sync({
          installationId: id,
          enabled: current.enabled,
          workers: workers.map((w) => ({
            ...w,
            available: activeBots.some((b) => b.id === w.id) && !busy.some((b) => b.botId === w.id),
          })),
          reports,
        });
        if (result.company.slug !== current.companySlug)
          throw new Error("Company identity changed");
        for (const dispatch of result.assignments) {
          const receipt = await prisma.workforceAssignment.findUnique({
            where: {
              connectionId_dispatchId: { connectionId: id, dispatchId: dispatch.dispatchId },
            },
          });
          if (dispatch.status === "cancelled") {
            if (receipt?.runId) {
              await prisma.run.updateMany({
                where: {
                  id: receipt.runId,
                  spaceId: current.spaceId,
                  status: { notIn: [...terminal] },
                },
                data: { status: "cancelled", completedAt: new Date() },
              });
              await jobs.cancel(runJobKey(receipt.runId));
            }
            continue;
          }
          if (dispatch.status !== "claimed" || receipt?.runId) continue;
          if (!workers.some((w) => w.id === dispatch.workerId))
            throw new Error("Company OS returned an unknown worker");
          const bot = await prisma.bot.findFirst({
            where: {
              id: dispatch.workerId,
              spaceId: current.spaceId,
              userId: current.userId,
              archivedAt: null,
            },
            include: { thread: true },
          });
          if (!bot?.thread) throw new Error("Assigned worker is unavailable");
          const assignment =
            receipt ??
            (await prisma.workforceAssignment.create({
              data: {
                connectionId: id,
                dispatchId: dispatch.dispatchId,
                seq: dispatch.seq,
                botId: bot.id,
              },
            }));
          const prompt = `Company OS request #${dispatch.seq}: ${dispatch.title}\n\n${dispatch.brief}`;
          const sent = await events.sendUserMessage({
            spaceId: current.spaceId,
            userId: current.userId,
            botId: bot.id,
            threadId: bot.thread.id,
            trigger: "webhook",
            prompt,
            blocks: [{ kind: "text", text: prompt }],
            clientNonce: `workforce:${id}:${dispatch.dispatchId}`,
          });
          if (!sent.runId) throw new Error("Assignment did not create a durable run");
          await prisma.workforceAssignment.update({
            where: { id: assignment.id },
            data: { runId: sent.runId },
          });
          await jobs.enqueue(runContinueJob(sent.runId));
        }
        await prisma.workforceAssignment.updateMany({
          where: { connectionId: id, dispatchId: { in: result.acknowledged } },
          data: { acknowledged: true },
        });
        await prisma.workforceConnection.update({
          where: { id },
          data: { lastSyncedAt: new Date(), lastError: null },
        });
      } catch {
        // Provider error bodies can contain credentials; persist only a safe actionable status.
        await prisma.workforceConnection.update({
          where: { id },
          data: {
            lastError: "Sync failed. Check the Company OS key, permissions, and connection.",
          },
        });
      } finally {
        await peer?.close().catch(() => {});
      }
    });
  }
  async function status(actor: Actor) {
    const row = await prisma.workforceConnection.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    });
    if (!row) return null;
    const assignments = await prisma.workforceAssignment.findMany({
      where: { connectionId: row.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const runs = await prisma.run.findMany({
      where: {
        id: { in: assignments.flatMap((a) => (a.runId ? [a.runId] : [])) },
        spaceId: actor.spaceId,
      },
      select: { id: true, status: true },
    });
    return {
      ...publicConnection(row),
      assignments: assignments.map((a) => ({
        id: a.id,
        seq: a.seq,
        botId: a.botId,
        runId: a.runId,
        synced: a.acknowledged,
        status: runs.find((r) => r.id === a.runId)?.status ?? "queued",
      })),
    };
  }
  async function setEnabled(actor: Actor, enabled: boolean) {
    const updated = await locked(`${actor.spaceId}:${actor.userId}`, async () => {
      await prisma.workforceConnection.updateMany({
        where: { spaceId: actor.spaceId, userId: actor.userId },
        data: { enabled },
      });
      return true;
    });
    if (!updated) throw new Error("Workforce sync is in progress; try again");
  }
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> | undefined;
  async function tick() {
    for (const row of await prisma.workforceConnection.findMany({ select: { id: true } })) {
      if (stopping) break;
      await tickConnection(row.id);
    }
  }
  function start() {
    const next = () => {
      pending = tick()
        .catch(() => {})
        .finally(() => {
          if (!stopping) timer = setTimeout(next, 15000);
        });
    };
    next();
  }
  async function stop() {
    stopping = true;
    if (timer) clearTimeout(timer);
    await pending;
  }
  return { configure, status, setEnabled, tickConnection, start, stop };
}
