import { createHash } from "node:crypto";
import type {
  AdapterContext,
  CloudAgentHandle,
  CloudAgentLaunchRequest,
  CloudAgentProvider,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
  CloudAgentStatus,
} from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected } from "@rakazo/adapter-kit";
import { z } from "zod";
import { readBodyCapped } from "./web-ssrf.js";

const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  status: z.string(),
  url: z.string().optional(),
  latestRunId: z.string().optional(),
});
const runSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["CREATING", "RUNNING", "FINISHED", "ERROR", "CANCELLED", "EXPIRED"]),
  git: z
    .object({
      branches: z.array(z.object({ branch: z.string().optional(), prUrl: z.string().optional() })),
    })
    .optional(),
});

export interface CursorCloudAgentOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Cursor v1 wire formats and credential handling stay inside this adapter. */
export class CursorCloudAgentProvider implements CloudAgentProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CursorCloudAgentOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("CURSOR_API_KEY is required");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  describe() {
    return {
      id: "cursor",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { launch: true, reply: true, cancel: true, offline: false },
    };
  }

  async launch(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    // Cursor's client-supplied id makes create replay safe after a lost response.
    const id = cursorAgentId(request.idempotencyKey);
    const response = await this.request(
      "POST",
      "/v1/agents",
      {
        agentId: id,
        prompt: {
          text: request.prompt,
          ...(request.images?.length ? { images: request.images } : {}),
        },
        ...(request.repository ? { repos: [{ url: request.repository }] } : {}),
        ...(request.openPr !== undefined ? { autoCreatePR: request.openPr } : {}),
      },
      request.signal ?? context.signal,
      true,
    );
    if (response === null) {
      // A duplicate create may precede read visibility. Failure to observe it
      // is still ambiguous and must not terminate recovery of accepted work.
      try {
        return await this.get(id, context);
      } catch {
        throw new Error("Cloud agent create is awaiting reconciliation");
      }
    }
    const parsed = z.object({ agent: agentSchema, run: runSchema }).safeParse(response);
    if (!parsed.success || parsed.data.agent.id !== id)
      throw new Error("Invalid cloud agent response");
    return this.handle(parsed.data.agent, parsed.data.run);
  }

  async get(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    const agent = await this.agent(id, context.signal);
    const currentRunId = runId ?? agent.latestRunId;
    if (!currentRunId) throw new Error("Cloud agent has no run to inspect");
    const parsed = runSchema.safeParse(
      await this.request(
        "GET",
        `/v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(currentRunId)}`,
        undefined,
        context.signal,
      ),
    );
    if (!parsed.success || parsed.data.id !== currentRunId)
      throw new Error("Invalid cloud agent run response");
    return this.handle(agent, parsed.data);
  }

  async reply(
    id: string,
    request: CloudAgentReplyRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    // Read metadata first: no fallible GET after a successful mutating POST.
    const agent = await this.agent(id, request.signal ?? context.signal);
    const parsed = z.object({ run: runSchema }).safeParse(
      await this.request(
        "POST",
        `/v1/agents/${encodeURIComponent(id)}/runs`,
        {
          prompt: {
            text: request.prompt,
            ...(request.images?.length ? { images: request.images } : {}),
          },
        },
        request.signal ?? context.signal,
      ),
    );
    if (!parsed.success) throw new Error("Invalid cloud agent follow-up response");
    return this.handle(agent, parsed.data.run);
  }

  async cancel(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    const snapshot = await this.get(id, context, runId);
    if (snapshot.status !== "running") return snapshot;
    await this.request(
      "POST",
      `/v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(snapshot.latestRunId!)}/cancel`,
      {},
      context.signal,
    );
    // Cancellation may still be in progress. Never report success before observing it.
    return this.get(id, context, snapshot.latestRunId);
  }

  private async agent(id: string, signal: AbortSignal) {
    const parsed = agentSchema.safeParse(
      await this.request("GET", `/v1/agents/${encodeURIComponent(id)}`, undefined, signal),
    );
    if (!parsed.success || parsed.data.id !== id) throw new Error("Invalid cloud agent response");
    return parsed.data;
  }

  private handle(
    agent: z.infer<typeof agentSchema>,
    run: z.infer<typeof runSchema>,
  ): CloudAgentSnapshot {
    const status: CloudAgentStatus =
      run.status === "FINISHED"
        ? "finished"
        : run.status === "CANCELLED"
          ? "cancelled"
          : run.status === "ERROR" || run.status === "EXPIRED"
            ? "failed"
            : "running";
    const branch = run.git?.branches[0];
    return {
      id: agent.id,
      title: agent.name || "Cloud agent",
      status,
      url: agent.url || `https://cursor.com/agents/${encodeURIComponent(agent.id)}`,
      latestRunId: run.id,
      ...(branch?.branch ? { branch: branch.branch } : {}),
      ...(branch?.prUrl ? { prUrl: branch.prUrl } : {}),
    };
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    allowConflict = false,
  ): Promise<unknown> {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    const response = await this.fetchImpl(`https://api.cursor.com${path}`, {
      method,
      redirect: "error",
      signal: boundedSignal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (allowConflict && response.status === 409) return null;
      if ([400, 401, 403, 404, 409, 422].includes(response.status))
        throw new CloudAgentRequestRejected();
      throw new Error(`Cloud agent request failed (${response.status})`);
    }
    if (response.status === 204) {
      void response.body?.cancel().catch(() => undefined);
      return {};
    }
    const bytes = await readBodyCapped(response, 1_000_000, boundedSignal);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Invalid cloud agent response");
    }
  }
}

export function cursorAgentId(key: string) {
  const bytes = createHash("sha256").update(key).digest();
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `bc-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
