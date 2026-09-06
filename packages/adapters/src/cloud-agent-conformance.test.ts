import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { EmulatorCloudAgentProvider } from "./cloud-agent-emulator.js";
import { cloudAgentsEnabled, createCloudAgentConnection } from "./cloud-agent-factory.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";
import { CursorCloudAgentEmulator } from "./testing/cursor-cloud-agent-emulator.js";

const ctx: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

const factories = {
  emulator() {
    const provider = new EmulatorCloudAgentProvider({ autoFinishAfterGets: null });
    return {
      provider,
      complete: (id: string, failed = false) => provider.complete(id, { failed }),
    };
  },
  cursor() {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    return { provider, complete: (id: string, failed = false) => wire.complete(id, { failed }) };
  },
};

for (const [name, create] of Object.entries(factories)) {
  describe(`${name} cloud agent conformance (offline)`, () => {
    it("replays launch without duplicate agents and preserves a finished run through a follow-up", async () => {
      const { provider, complete } = create();
      const request = {
        idempotencyKey: "create-1",
        prompt: "Add a README",
        repository: "https://github.com/example/demo",
        openPr: true,
      };
      const first = await provider.launch(request, ctx);
      expect(first.status).toBe("running");
      expect((await provider.launch(request, ctx)).id).toBe(first.id);
      complete(first.id);
      const done = await provider.get(first.id, ctx);
      expect(done).toMatchObject({ status: "finished", branch: "emulator/task" });
      expect(done.prUrl).toContain("/pull/");
      const followup = await provider.reply(first.id, { prompt: "Also add tests" }, ctx);
      expect(followup.latestRunId).not.toBe(first.latestRunId);
      expect((await provider.get(first.id, ctx, first.latestRunId)).status).toBe("finished");
      expect((await provider.get(first.id, ctx, followup.latestRunId)).status).toBe("running");
      expect((await provider.cancel(first.id, ctx)).status).toBe("cancelled");
      expect((await provider.cancel(first.id, ctx)).status).toBe("cancelled");
    });
    it("rejects concurrent follow-ups and observes failures", async () => {
      const { provider, complete } = create();
      const first = await provider.launch({ idempotencyKey: "busy", prompt: "Task" }, ctx);
      await expect(provider.reply(first.id, { prompt: "Busy" }, ctx)).rejects.toThrow();
      complete(first.id, true);
      expect((await provider.get(first.id, ctx)).status).toBe("failed");
    });
    it("honors abort and does not open a PR when disabled", async () => {
      const { provider, complete } = create();
      await expect(
        provider.launch(
          { idempotencyKey: "aborted", prompt: "Task" },
          { ...ctx, signal: AbortSignal.abort() },
        ),
      ).rejects.toThrow();
      const first = await provider.launch(
        {
          idempotencyKey: "no-pr",
          prompt: "Task",
          openPr: false,
          repository: "https://github.com/example/demo",
        },
        ctx,
      );
      complete(first.id);
      expect((await provider.get(first.id, ctx)).prUrl).toBeUndefined();
    });
  });
}

describe("cloud agent composition", () => {
  it("fails closed without explicit credential and Space configuration", () => {
    for (const source of [
      {},
      { CLOUD_AGENT_PROVIDER: "bogus" },
      { CLOUD_AGENT_PROVIDER: "cursor" },
      { CLOUD_AGENT_PROVIDER: "cursor", CURSOR_API_KEY: "fake-key" },
    ]) {
      expect(resolveCloudAgentProvider(source)).toBe("none");
      expect(createCloudAgentConnection(source)).toBeNull();
    }
    const connection = createCloudAgentConnection({
      CLOUD_AGENT_PROVIDER: "cursor",
      CURSOR_API_KEY: "fake-key",
      CLOUD_AGENT_SPACE_ID: "test-space",
    })!;
    expect(cloudAgentsEnabled(connection, "test-space")).toBe(true);
    expect(cloudAgentsEnabled(connection, "other-space")).toBe(false);
    expect(connection.key).not.toContain("fake-key");
    const rotated = createCloudAgentConnection({
      CLOUD_AGENT_PROVIDER: "cursor",
      CURSOR_API_KEY: "other-fake-key",
      CLOUD_AGENT_SPACE_ID: "test-space",
    })!;
    expect(rotated.key).not.toBe(connection.key);
  });
  it("never grants an unscoped live provider access", () => {
    expect(
      cloudAgentsEnabled(
        { provider: new CursorCloudAgentProvider({ apiKey: "fake-key" }), key: "test" },
        "test-space",
      ),
    ).toBe(false);
    expect(
      cloudAgentsEnabled(
        createCloudAgentConnection({ CLOUD_AGENT_PROVIDER: "emulator" }),
        "test-space",
      ),
    ).toBe(true);
  });
});
