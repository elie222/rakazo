import type {
  AdapterContext,
  CloudAgentHandle,
  CloudAgentLaunchRequest,
  CloudAgentProvider,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
  CloudAgentStatus,
} from "@rakazo/adapter-kit";

interface EmulatorAgent {
  id: string;
  url: string;
  title: string;
  status: CloudAgentStatus;
  latestRunId: string;
  branch?: string;
  prUrl?: string;
  repository?: string;
  prompt: string;
  replies: string[];
  /** Gets while status is running; auto-finishes after a few so E2E polls terminate. */
  runningGets: number;
}

/** After this many get() calls while running, the emulator finishes (branch/PR if openPr). */
const AUTO_FINISH_AFTER_GETS = 2;

/**
 * In-process cloud agent provider for unit tests and Playwright. Never hits
 * the network. Launch stays running until complete() or cancel().
 */
export class EmulatorCloudAgentProvider implements CloudAgentProvider {
  readonly agents = new Map<string, EmulatorAgent>();
  private seq = 0;

  describe() {
    return {
      id: "emulator",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        launch: true,
        reply: true,
        cancel: true,
        offline: true,
      },
    };
  }

  async launch(
    request: CloudAgentLaunchRequest,
    _context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error("prompt is required");
    this.seq += 1;
    const id = `emu-agent-${this.seq}`;
    const runId = `emu-run-${this.seq}`;
    const title = titleFromPrompt(prompt);
    const agent: EmulatorAgent = {
      id,
      url: `https://cloud-agent.test/agents/${id}`,
      title,
      status: "running",
      latestRunId: runId,
      repository: request.repository,
      prompt,
      replies: [],
      runningGets: 0,
      ...(request.openPr
        ? {
            branch: `emulator/${slug(title)}`,
          }
        : {}),
    };
    this.agents.set(id, agent);
    return handleOf(agent);
  }

  async get(id: string, _context: AdapterContext): Promise<CloudAgentSnapshot> {
    const agent = this.require(id);
    if (agent.status === "running") {
      agent.runningGets += 1;
      if (agent.runningGets >= AUTO_FINISH_AFTER_GETS) {
        this.complete(id);
      }
    }
    return snapshotOf(agent);
  }

  async reply(
    id: string,
    request: CloudAgentReplyRequest,
    _context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    const agent = this.require(id);
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error("prompt is required");
    if (agent.status === "cancelled") throw new Error("agent is cancelled");
    this.seq += 1;
    agent.latestRunId = `emu-run-${this.seq}`;
    agent.status = "running";
    agent.runningGets = 0;
    agent.replies.push(prompt);
    return handleOf(agent);
  }

  async cancel(id: string, _context: AdapterContext): Promise<CloudAgentSnapshot> {
    const agent = this.require(id);
    agent.status = "cancelled";
    return snapshotOf(agent);
  }

  /** Test helper: mark an agent finished with an optional fake branch/PR. */
  complete(
    id: string,
    options?: { branch?: string; prUrl?: string; failed?: boolean },
  ): CloudAgentSnapshot {
    const agent = this.require(id);
    agent.status = options?.failed ? "failed" : "finished";
    if (options?.branch) agent.branch = options.branch;
    if (options?.prUrl) agent.prUrl = options.prUrl;
    if (!options?.failed && !agent.branch) {
      agent.branch = `emulator/${slug(agent.title)}`;
    }
    if (!options?.failed && !agent.prUrl && agent.repository) {
      agent.prUrl = `${agent.repository.replace(/\.git$/, "")}/pull/${this.seq}`;
    }
    return snapshotOf(agent);
  }

  private require(id: string): EmulatorAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Unknown cloud agent "${id}"`);
    return agent;
  }
}

function handleOf(agent: EmulatorAgent): CloudAgentHandle {
  return {
    id: agent.id,
    url: agent.url,
    title: agent.title,
    status: agent.status,
    latestRunId: agent.latestRunId,
  };
}

function snapshotOf(agent: EmulatorAgent): CloudAgentSnapshot {
  return {
    id: agent.id,
    url: agent.url,
    title: agent.title,
    status: agent.status,
    latestRunId: agent.latestRunId,
    ...(agent.branch ? { branch: agent.branch } : {}),
    ...(agent.prUrl ? { prUrl: agent.prUrl } : {}),
  };
}

function titleFromPrompt(prompt: string): string {
  const line = prompt.split(/\r?\n/, 1)[0]?.trim() || "Cloud agent";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "task"
  );
}
