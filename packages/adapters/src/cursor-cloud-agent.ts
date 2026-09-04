import type {
  AdapterContext,
  CloudAgentHandle,
  CloudAgentImage,
  CloudAgentLaunchRequest,
  CloudAgentProvider,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
  CloudAgentStatus,
} from "@rakazo/adapter-kit";

const DEFAULT_BASE_URL = "https://api.cursor.com";

export interface CursorCloudAgentOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Cursor Cloud Agents API v1 adapter. Vendor wire formats stay inside this
 * file; callers only see CloudAgentProvider.
 */
export class CursorCloudAgentProvider implements CloudAgentProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CursorCloudAgentOptions) {
    const key = options.apiKey.trim();
    if (!key) throw new Error("CURSOR_API_KEY is required for the cursor cloud agent provider");
    this.apiKey = key;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  describe() {
    return {
      id: "cursor",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        launch: true,
        reply: true,
        cancel: true,
        offline: false,
      },
    };
  }

  async launch(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error("prompt is required");
    const body: Record<string, unknown> = {
      prompt: {
        text: prompt,
        ...(request.images?.length ? { images: mapImages(request.images) } : {}),
      },
    };
    if (request.repository?.trim()) {
      body.repos = [{ url: request.repository.trim() }];
    }
    if (request.environment && Object.keys(request.environment).length > 0) {
      body.envVars = request.environment;
    }
    if (request.openPr !== undefined) {
      body.autoCreatePR = request.openPr;
    }
    const json = await this.request<{
      agent?: CursorAgent;
      run?: CursorRun;
    }>("POST", "/v1/agents", body, request.signal ?? context.signal);
    const agent = json.agent;
    if (!agent?.id) throw new Error("Cursor create agent response missing agent.id");
    return {
      id: agent.id,
      url: agent.url || `${this.baseUrl.replace("api.", "")}/agents/${agent.id}`,
      title: agent.name || titleFromPrompt(prompt),
      status: mapRunStatus(json.run?.status) ?? mapAgentStatus(agent.status),
      latestRunId: json.run?.id ?? agent.latestRunId,
    };
  }

  async get(id: string, context: AdapterContext): Promise<CloudAgentSnapshot> {
    const agent = await this.request<CursorAgent>(
      "GET",
      `/v1/agents/${encodeURIComponent(id)}`,
      undefined,
      context.signal,
    );
    const runId = agent.latestRunId;
    let run: CursorRun | undefined;
    if (runId) {
      run = await this.request<CursorRun>(
        "GET",
        `/v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
        undefined,
        context.signal,
      );
    }
    const branch = run?.git?.branches?.[0];
    return {
      id: agent.id,
      url: agent.url || `https://cursor.com/agents/${agent.id}`,
      title: agent.name || agent.id,
      status: mapRunStatus(run?.status) ?? mapAgentStatus(agent.status),
      latestRunId: runId,
      ...(branch?.branch ? { branch: branch.branch } : {}),
      ...(branch?.prUrl ? { prUrl: branch.prUrl } : {}),
    };
  }

  async reply(
    id: string,
    request: CloudAgentReplyRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error("prompt is required");
    const json = await this.request<{ run?: CursorRun }>(
      "POST",
      `/v1/agents/${encodeURIComponent(id)}/runs`,
      {
        prompt: {
          text: prompt,
          ...(request.images?.length ? { images: mapImages(request.images) } : {}),
        },
      },
      request.signal ?? context.signal,
    );
    const agent = await this.request<CursorAgent>(
      "GET",
      `/v1/agents/${encodeURIComponent(id)}`,
      undefined,
      context.signal,
    );
    return {
      id: agent.id,
      url: agent.url || `https://cursor.com/agents/${agent.id}`,
      title: agent.name || agent.id,
      status: mapRunStatus(json.run?.status) ?? "running",
      latestRunId: json.run?.id ?? agent.latestRunId,
    };
  }

  async cancel(id: string, context: AdapterContext): Promise<CloudAgentSnapshot> {
    const agent = await this.request<CursorAgent>(
      "GET",
      `/v1/agents/${encodeURIComponent(id)}`,
      undefined,
      context.signal,
    );
    const runId = agent.latestRunId;
    if (!runId) {
      return {
        id: agent.id,
        url: agent.url || `https://cursor.com/agents/${agent.id}`,
        title: agent.name || agent.id,
        status: mapAgentStatus(agent.status),
      };
    }
    await this.request(
      "POST",
      `/v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/cancel`,
      {},
      context.signal,
    );
    return this.get(id, context);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown | undefined,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Cursor cloud agent ${method} ${path} failed (${response.status}): ${text}`);
    }
    if (response.status === 204) return {} as T;
    return (await response.json()) as T;
  }
}

interface CursorAgent {
  id: string;
  name?: string;
  status?: string;
  url?: string;
  latestRunId?: string;
}

interface CursorRun {
  id?: string;
  status?: string;
  git?: {
    branches?: Array<{ repoUrl?: string; branch?: string; prUrl?: string }>;
  };
}

function mapImages(images: CloudAgentImage[]) {
  return images.map((image) => {
    if ("url" in image) return { url: image.url };
    return { data: image.data, mimeType: image.mimeType };
  });
}

function mapRunStatus(status: string | undefined): CloudAgentStatus | undefined {
  if (!status) return undefined;
  const normalized = status.toUpperCase();
  if (
    normalized === "CREATING" ||
    normalized === "RUNNING" ||
    normalized === "QUEUED" ||
    normalized === "PENDING"
  ) {
    return "running";
  }
  if (normalized === "FINISHED" || normalized === "COMPLETED" || normalized === "DONE") {
    return "finished";
  }
  if (normalized === "CANCELLED" || normalized === "CANCELED") return "cancelled";
  if (
    normalized === "ERROR" ||
    normalized === "FAILED" ||
    normalized === "EXPIRED" ||
    normalized === "ERRORED"
  ) {
    return "failed";
  }
  return "running";
}

function mapAgentStatus(status: string | undefined): CloudAgentStatus {
  if (!status) return "running";
  const normalized = status.toUpperCase();
  if (normalized === "ACTIVE") return "running";
  if (normalized === "IDLE") return "finished";
  if (normalized === "ARCHIVED") return "cancelled";
  return "running";
}

function titleFromPrompt(prompt: string): string {
  const line = prompt.split(/\r?\n/, 1)[0]?.trim() || "Cloud agent";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
