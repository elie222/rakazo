import type { AdapterContext, CloudAgentProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { EmulatorCloudAgentProvider } from "./cloud-agent-emulator.js";
import { createCloudAgentProvider } from "./cloud-agent-factory.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "s",
  userId: "u",
  signal: new AbortController().signal,
};

async function assertOfflineConformance(provider: CloudAgentProvider) {
  const desc = provider.describe();
  expect(desc.capabilities.launch).toBe(true);
  expect(desc.capabilities.reply).toBe(true);
  expect(desc.capabilities.cancel).toBe(true);
  expect(desc.contractVersion).toBe("1");

  const launched = await provider.launch(
    {
      prompt: "Add a health check endpoint",
      repository: "https://github.com/example/demo",
      openPr: true,
    },
    ctx,
  );
  expect(launched.id).toBeTruthy();
  expect(launched.url).toMatch(/^https?:\/\//);
  expect(launched.title).toBeTruthy();
  expect(launched.status).toBe("running");

  const mid = await provider.get(launched.id, ctx);
  expect(mid.id).toBe(launched.id);
  expect(mid.status).toBe("running");

  const replied = await provider.reply(launched.id, { prompt: "Also add tests" }, ctx);
  expect(replied.id).toBe(launched.id);

  if (provider instanceof EmulatorCloudAgentProvider) {
    provider.complete(launched.id, {
      branch: "emulator/health-check",
      prUrl: "https://github.com/example/demo/pull/1",
    });
    const done = await provider.get(launched.id, ctx);
    expect(done.status).toBe("finished");
    expect(done.branch).toBeTruthy();
    expect(done.prUrl).toMatch(/^https?:\/\//);
  }

  const other = await provider.launch({ prompt: "Cancel me" }, ctx);
  const cancelled = await provider.cancel(other.id, ctx);
  expect(cancelled.status).toBe("cancelled");
}

describe("cloud agent provider", () => {
  it("resolves none by default and soft-falls cursor without a key", () => {
    expect(resolveCloudAgentProvider({})).toBe("none");
    expect(resolveCloudAgentProvider({ CLOUD_AGENT_PROVIDER: "" })).toBe("none");
    expect(resolveCloudAgentProvider({ CLOUD_AGENT_PROVIDER: "cursor" })).toBe("none");
    expect(
      resolveCloudAgentProvider({ CLOUD_AGENT_PROVIDER: "cursor", CURSOR_API_KEY: "ck_test" }),
    ).toBe("cursor");
    expect(resolveCloudAgentProvider({ CLOUD_AGENT_PROVIDER: "emulator" })).toBe("emulator");
    expect(resolveCloudAgentProvider({ CLOUD_AGENT_PROVIDER: "bogus-vendor" })).toBe("none");
    expect(createCloudAgentProvider("bogus-vendor")).toBeNull();
  });

  it("factory returns null for none", () => {
    expect(createCloudAgentProvider("none")).toBeNull();
    expect(createCloudAgentProvider("cursor", { cursorApiKey: "" })).toBeNull();
    expect(createCloudAgentProvider("emulator")).toBeInstanceOf(EmulatorCloudAgentProvider);
  });

  it("holds conformance for emulator (offline)", async () => {
    await assertOfflineConformance(new EmulatorCloudAgentProvider());
  });

  it("maps cursor HTTP with an injected fetch (offline)", async () => {
    let latestRunStatus = "RUNNING";
    const provider = new CursorCloudAgentProvider({
      apiKey: "ck_test",
      fetch: async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST" && /\/v1\/agents$/.test(url)) {
          return Response.json({
            agent: {
              id: "bc-1",
              name: "Task",
              status: "ACTIVE",
              url: "https://cursor.com/agents/bc-1",
              latestRunId: "run-1",
            },
            run: { id: "run-1", status: "CREATING" },
          });
        }
        if (method === "GET" && url.endsWith("/v1/agents/bc-1")) {
          return Response.json({
            id: "bc-1",
            name: "Task",
            status:
              latestRunStatus === "FINISHED" || latestRunStatus === "CANCELLED" ? "IDLE" : "ACTIVE",
            url: "https://cursor.com/agents/bc-1",
            latestRunId: "run-1",
          });
        }
        if (method === "POST" && url.endsWith("/v1/agents/bc-1/runs")) {
          return Response.json({ run: { id: "run-2", status: "CREATING" } });
        }
        if (method === "GET" && url.includes("/runs/")) {
          return Response.json({
            id: "run-1",
            status: latestRunStatus,
            git:
              latestRunStatus === "FINISHED"
                ? {
                    branches: [
                      {
                        branch: "cursor/task",
                        prUrl: "https://github.com/example/demo/pull/1",
                      },
                    ],
                  }
                : undefined,
          });
        }
        if (method === "POST" && url.endsWith("/cancel")) {
          latestRunStatus = "CANCELLED";
          return Response.json({ id: "run-1" });
        }
        return new Response(`unexpected ${method} ${url}`, { status: 500 });
      },
    });

    const launched = await provider.launch({ prompt: "Task" }, ctx);
    expect(launched.id).toBe("bc-1");
    expect(launched.status).toBe("running");
    await provider.reply(launched.id, { prompt: "More" }, ctx);
    latestRunStatus = "FINISHED";
    const done = await provider.get(launched.id, ctx);
    expect(done.status).toBe("finished");
    expect(done.prUrl).toContain("/pull/1");
    latestRunStatus = "RUNNING";
    const cancelled = await provider.cancel(launched.id, ctx);
    expect(cancelled.status).toBe("cancelled");
  });
});
