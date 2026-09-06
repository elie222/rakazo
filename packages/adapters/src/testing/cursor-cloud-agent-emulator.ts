import type { AdapterContext, CloudAgentSnapshot } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected } from "@rakazo/adapter-kit";
import { EmulatorCloudAgentProvider } from "../cloud-agent-emulator.js";

/** In-process Cursor v1 HTTP server substitute, including post-commit transport faults. */
export class CursorCloudAgentEmulator {
  readonly provider = new EmulatorCloudAgentProvider({ autoFinishAfterGets: null });
  readonly ids = new Map<string, string>();
  readonly requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  staleLatestRunId: string | undefined;
  loseNextLaunchResponse = false;
  loseNextReplyResponse = false;
  failNextRequest: number | undefined;
  cancelPending = false;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.cursor.com") throw new Error("Unexpected emulator origin");
    if (new Headers(init?.headers).get("authorization") !== "Bearer fake-key")
      return new Response(null, { status: 401 });
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, path: url.pathname, body });
    if (this.failNextRequest) {
      const status = this.failNextRequest;
      this.failNextRequest = undefined;
      return new Response("fake-key must never be exposed", { status });
    }
    const context: AdapterContext = {
      operationId: "wire-test",
      traceId: "wire-test",
      spaceId: "test-space",
      userId: "test-user",
      signal: init?.signal ?? new AbortController().signal,
    };
    if (url.pathname === "/v1/agents" && method === "POST") {
      if (this.ids.has(body.agentId)) return new Response(null, { status: 409 });
      const launched = await this.provider.launch(
        {
          idempotencyKey: body.agentId,
          prompt: body.prompt.text,
          images: body.prompt.images,
          repository: body.repos?.[0]?.url,
          openPr: body.autoCreatePR,
        },
        context,
      );
      this.ids.set(body.agentId, launched.id);
      if (this.loseNextLaunchResponse) {
        this.loseNextLaunchResponse = false;
        throw new Error("Connection lost after create");
      }
      return Response.json({ agent: this.agent(body.agentId), run: this.run(launched) });
    }
    const match = /^\/v1\/agents\/([^/]+)(?:\/runs(?:\/([^/]+)(\/cancel)?)?)?$/.exec(url.pathname);
    if (!match) return new Response(null, { status: 404 });
    const id = decodeURIComponent(match[1]!);
    const internalId = this.ids.get(id);
    if (!internalId) return new Response(null, { status: 404 });
    try {
      if (method === "GET" && !url.pathname.includes("/runs")) return Response.json(this.agent(id));
      if (method === "GET")
        return Response.json(this.run(await this.provider.get(internalId, context, match[2])));
      if (match[3]) {
        if (!this.cancelPending) await this.provider.cancel(internalId, context, match[2]);
        return new Response(null, { status: 204 });
      }
      const reply = await this.provider.reply(
        internalId,
        { prompt: body.prompt.text, images: body.prompt.images },
        context,
      );
      if (this.loseNextReplyResponse) {
        this.loseNextReplyResponse = false;
        throw new Error("Connection lost after reply");
      }
      return Response.json({ run: this.run(reply) });
    } catch (error) {
      if (error instanceof CloudAgentRequestRejected) return new Response(null, { status: 409 });
      throw error;
    }
  };

  complete(id: string, options: { failed?: boolean; prUrl?: string } = {}) {
    return this.provider.complete(this.ids.get(id)!, options);
  }

  private agent(id: string) {
    const agent = this.provider.agents.get(this.ids.get(id)!)!;
    return {
      id,
      name: agent.title,
      status: "ACTIVE",
      url: `https://cursor.com/agents/${id}`,
      latestRunId: this.staleLatestRunId ?? agent.latestRunId,
    };
  }

  private run(snapshot: CloudAgentSnapshot) {
    return {
      id: snapshot.latestRunId,
      status: { running: "RUNNING", finished: "FINISHED", failed: "ERROR", cancelled: "CANCELLED" }[
        snapshot.status
      ],
      git: {
        branches: snapshot.branch ? [{ branch: snapshot.branch, prUrl: snapshot.prUrl }] : [],
      },
    };
  }
}
