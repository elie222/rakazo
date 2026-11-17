import { describe, expect, it } from "vitest";
import { createAxiomSinkFromEnv } from "./axiom.js";
import type { AxiomIngestClient } from "./axiom-sink.js";
import { createAxiomSink } from "./axiom-sink.js";
import { createLogger } from "./logger.js";
import type { LogEvent } from "./types.js";

class FakeAxiom implements AxiomIngestClient {
  readonly ingested: Array<{ dataset: string; events: object[] }> = [];
  flushed = 0;
  failIngest = false;
  failFlush = false;

  ingest(dataset: string, events: object[]): void {
    if (this.failIngest) throw new Error("ingest failed");
    this.ingested.push({ dataset, events });
  }

  async flush(): Promise<void> {
    if (this.failFlush) throw new Error("flush failed");
    this.flushed += 1;
  }
}

// Sends what was written since the last flush as one request, the way the store's client batches,
// and loses the whole request when one line cannot be serialized or holds a field the store refuses.
class BatchingStore implements AxiomIngestClient {
  readonly stored: Array<Record<string, unknown>> = [];
  private pending: object[] = [];

  ingest(_dataset: string, events: object[]): void {
    this.pending.push(...events);
  }

  async flush(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    const lines = batch.map((event) => JSON.stringify(event));
    if (lines.some((line) => line.length > 1_000_000)) throw new Error("request refused");
    this.stored.push(...lines.map((line) => JSON.parse(line)));
  }
}

function sampleEvent(): LogEvent {
  return {
    timestamp: "2026-01-02T03:04:05.000Z",
    level: "info",
    message: "hello",
    "service.name": "rakazo-api",
  };
}

describe("axiom sink", () => {
  it("ingests through the injected client and flushes", async () => {
    const client = new FakeAxiom();
    const sink = await createAxiomSink({ dataset: "rakazo-logs", client });
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    logger.info("hello", { "request.id": "r1" });
    await logger.flush();
    expect(client.ingested).toHaveLength(1);
    expect(client.ingested[0]?.dataset).toBe("rakazo-logs");
    expect(client.ingested[0]?.events[0]).toMatchObject({
      message: "hello",
      "service.name": "rakazo-api",
      "request.id": "r1",
    });
    expect(client.flushed).toBe(1);
  });

  it("does not throw when ingest or flush fails", async () => {
    const client = new FakeAxiom();
    client.failIngest = true;
    const sink = await createAxiomSink({ dataset: "rakazo-logs", client });
    expect(() => sink.write(sampleEvent())).not.toThrow();
    client.failFlush = true;
    await expect(sink.flush?.()).resolves.toBeUndefined();
  });

  it("enables only when token and dataset are both set", async () => {
    const client = new FakeAxiom();
    expect(await createAxiomSinkFromEnv({}, client)).toEqual({});
    expect(await createAxiomSinkFromEnv({ AXIOM_TOKEN: "t" }, client)).toEqual({
      warning: "Axiom logging is disabled; AXIOM_TOKEN and AXIOM_DATASET must both be set.",
    });
    expect((await createAxiomSinkFromEnv({ AXIOM_DATASET: "logs" }, client)).warning).toMatch(
      /disabled/,
    );
    const enabled = await createAxiomSinkFromEnv(
      {
        AXIOM_TOKEN: "t",
        AXIOM_DATASET: "logs",
        AXIOM_EDGE: "eu-central-1.aws.edge.axiom.co",
        AXIOM_EDGE_URL: "https://edge.example",
      },
      client,
    );
    expect(enabled.sink).toBeDefined();
    expect(enabled.warning).toBeUndefined();
  });

  it("rejects non-https edge URLs and non-hostname edges", async () => {
    const client = new FakeAxiom();
    const httpUrl = await createAxiomSinkFromEnv(
      {
        AXIOM_TOKEN: "t",
        AXIOM_DATASET: "logs",
        AXIOM_EDGE_URL: "http://edge.example",
      },
      client,
    );
    expect(httpUrl.sink).toBeUndefined();
    expect(httpUrl.warning).toMatch(/https/);

    const badHost = await createAxiomSinkFromEnv(
      {
        AXIOM_TOKEN: "t",
        AXIOM_DATASET: "logs",
        AXIOM_EDGE: "https://eu-central-1.aws.edge.axiom.co",
      },
      client,
    );
    expect(badHost.sink).toBeUndefined();
    expect(badHost.warning).toMatch(/hostname/);

    const withUser = await createAxiomSinkFromEnv(
      {
        AXIOM_TOKEN: "t",
        AXIOM_DATASET: "logs",
        AXIOM_EDGE_URL: "https://user:pass@edge.example",
      },
      client,
    );
    expect(withUser.sink).toBeUndefined();
    expect(withUser.warning).toMatch(/credentials/);
  });

  it("keeps the other lines of a batch when one line is too large for the store", async () => {
    const store = new BatchingStore();
    const sink = await createAxiomSink({ dataset: "rakazo-logs", client: store });
    const logger = createLogger({ service: "rakazo-worker", sinks: [sink] });
    logger.info("run.execution_started", { "run.id": "run-a" });
    logger.warn("run.setup_failed", {
      "run.id": "run-a",
      error: new Error(`token=hunter2secretvalue ${"x".repeat(2_000_000)}`),
    });
    logger.warn("run.failed", { "run.id": "run-b" });
    await logger.flush();

    expect(store.stored.map((event) => event.message)).toEqual([
      "run.execution_started",
      "run.setup_failed",
      "run.failed",
    ]);
    const failed = store.stored[1]!;
    expect(failed).toMatchObject({ "run.id": "run-a", "log.truncated": true });
    expect(JSON.stringify(failed).length).toBeLessThan(100_000);
    expect(JSON.stringify(failed)).not.toContain("hunter2secretvalue");
  });

  it("keeps redacted text out of a stand-in", async () => {
    const store = new BatchingStore();
    const sink = await createAxiomSink({ dataset: "rakazo-logs", client: store });
    const logger = createLogger({ service: "rakazo-worker", sinks: [sink] });
    logger.warn("run.setup_failed", {
      "run.id": "run-a",
      note: "token=hunter2secretvalue",
      attempts: Array.from({ length: 200 }, () => "y".repeat(10_000)),
      error: new Error("token=hunter2secretvalue"),
    });
    await logger.flush();

    expect(store.stored).toEqual([expect.objectContaining({ "log.oversized": true })]);
    expect(JSON.stringify(store.stored)).not.toContain("hunter2secretvalue");
  });

  it("stands in for a line that cannot be serialized, and keeps the rest of its batch", async () => {
    const store = new BatchingStore();
    const sink = await createAxiomSink({ dataset: "rakazo-logs", client: store });
    const logger = createLogger({ service: "rakazo-worker", sinks: [sink] });
    const unserializable = {
      toJSON() {
        throw new Error("cannot serialize");
      },
    };
    logger.warn("run.setup_failed", { "run.id": "run-a", detail: unserializable });
    logger.warn("run.failed", { "run.id": "run-b" });
    await logger.flush();

    expect(store.stored).toEqual([
      expect.objectContaining({
        message: "run.setup_failed",
        "run.id": "run-a",
        "log.unserializable": true,
      }),
      expect.objectContaining({ message: "run.failed", "run.id": "run-b" }),
    ]);
  });

  it("stands in for a line too large overall, with its run named", async () => {
    const store = new BatchingStore();
    const sink = await createAxiomSink({ dataset: "rakazo-logs", client: store });
    const logger = createLogger({ service: "rakazo-worker", sinks: [sink] });
    logger.warn("run.setup_failed", {
      "run.id": "run-a",
      attempts: Array.from({ length: 200 }, () => "y".repeat(10_000)),
    });
    await logger.flush();

    expect(store.stored).toEqual([
      expect.objectContaining({ "run.id": "run-a", "log.oversized": true }),
    ]);
    expect(store.stored[0]).not.toHaveProperty("attempts");
  });
});
