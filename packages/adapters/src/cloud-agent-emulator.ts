import type {
  AdapterContext,
  CloudAgentLaunchRequest,
  CloudAgentProvider,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
} from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected } from "@rakazo/adapter-kit";

interface EmulatorAgent {
  id: string;
  title: string;
  repository?: string;
  openPr: boolean;
  latestRunId: string;
  runs: Map<string, CloudAgentSnapshot>;
  runningGets: number;
}

/** Offline provider with durable identity, individual runs, and explicit completion controls. */
export class EmulatorCloudAgentProvider implements CloudAgentProvider {
  readonly agents = new Map<string, EmulatorAgent>();
  private sequence = 0;
  constructor(private readonly options: { autoFinishAfterGets?: number | null } = {}) {}

  describe() {
    return {
      id: "emulator",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { launch: true, reply: true, cancel: true, offline: true },
    };
  }

  async launch(request: CloudAgentLaunchRequest, context: AdapterContext) {
    context.signal.throwIfAborted();
    const id = `emu-agent-${request.idempotencyKey}`;
    const existing = this.agents.get(id);
    if (existing) return { ...existing.runs.get(existing.latestRunId)! };
    if (!request.prompt.trim()) throw new CloudAgentRequestRejected();
    const agent: EmulatorAgent = {
      id,
      title: request.prompt.split(/\r?\n/, 1)[0]!.slice(0, 80),
      repository: request.repository,
      openPr: request.openPr ?? false,
      latestRunId: "",
      runs: new Map(),
      runningGets: 0,
    };
    this.agents.set(id, agent);
    return this.startRun(agent);
  }

  async get(id: string, context: AdapterContext, runId?: string) {
    context.signal.throwIfAborted();
    const agent = this.require(id);
    const run = agent.runs.get(runId ?? agent.latestRunId);
    if (!run) throw new CloudAgentRequestRejected();
    const limit =
      this.options.autoFinishAfterGets === undefined ? 2 : this.options.autoFinishAfterGets;
    if (run.status === "running" && limit !== null) {
      agent.runningGets++;
      if (agent.runningGets >= limit) this.complete(id);
    }
    return { ...run };
  }

  async reply(id: string, request: CloudAgentReplyRequest, context: AdapterContext) {
    context.signal.throwIfAborted();
    const agent = this.require(id);
    if (!request.prompt.trim() || agent.runs.get(agent.latestRunId)!.status === "running")
      throw new CloudAgentRequestRejected();
    return this.startRun(agent);
  }

  async cancel(id: string, context: AdapterContext, runId?: string) {
    context.signal.throwIfAborted();
    const agent = this.require(id);
    const run = agent.runs.get(runId ?? agent.latestRunId);
    if (!run) throw new CloudAgentRequestRejected();
    if (run.status === "running") run.status = "cancelled";
    return { ...run };
  }

  complete(id: string, options: { branch?: string; prUrl?: string; failed?: boolean } = {}) {
    const agent = this.require(id);
    const run = agent.runs.get(agent.latestRunId)!;
    run.status = options.failed ? "failed" : "finished";
    run.branch = options.branch ?? "emulator/task";
    run.prUrl =
      options.prUrl ??
      (agent.openPr && agent.repository
        ? `${agent.repository.replace(/\.git$/, "")}/pull/1`
        : undefined);
    return { ...run };
  }

  private startRun(agent: EmulatorAgent) {
    const latestRunId = `emu-run-${++this.sequence}`;
    const run: CloudAgentSnapshot = {
      id: agent.id,
      title: agent.title,
      url: `https://cloud-agent.test/agents/${agent.id}`,
      status: "running",
      latestRunId,
    };
    agent.latestRunId = latestRunId;
    agent.runningGets = 0;
    agent.runs.set(latestRunId, run);
    return { ...run };
  }

  private require(id: string) {
    const agent = this.agents.get(id);
    if (!agent) throw new CloudAgentRequestRejected();
    return agent;
  }
}
