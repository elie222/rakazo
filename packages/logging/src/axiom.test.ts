import { describe, expect, it } from "vitest";
import { type AxiomIngestClient, createAxiomSink, createAxiomSinkFromEnv } from "./axiom.js";
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
    const sink = createAxiomSink({ dataset: "rakazo-logs", client });
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
    const sink = createAxiomSink({ dataset: "rakazo-logs", client });
    expect(() => sink.write(sampleEvent())).not.toThrow();
    client.failFlush = true;
    await expect(sink.flush?.()).resolves.toBeUndefined();
  });

  it("enables only when token and dataset are both set", () => {
    const client = new FakeAxiom();
    expect(createAxiomSinkFromEnv({}, client)).toEqual({});
    expect(createAxiomSinkFromEnv({ AXIOM_TOKEN: "t" }, client)).toEqual({
      warning: "Axiom logging is disabled; AXIOM_TOKEN and AXIOM_DATASET must both be set.",
    });
    expect(createAxiomSinkFromEnv({ AXIOM_DATASET: "logs" }, client).warning).toMatch(/disabled/);
    const enabled = createAxiomSinkFromEnv(
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

  it("rejects non-https edge URLs and non-hostname edges", () => {
    const client = new FakeAxiom();
    const httpUrl = createAxiomSinkFromEnv(
      {
        AXIOM_TOKEN: "t",
        AXIOM_DATASET: "logs",
        AXIOM_EDGE_URL: "http://edge.example",
      },
      client,
    );
    expect(httpUrl.sink).toBeUndefined();
    expect(httpUrl.warning).toMatch(/https/);

    const badHost = createAxiomSinkFromEnv(
      {
        AXIOM_TOKEN: "t",
        AXIOM_DATASET: "logs",
        AXIOM_EDGE: "https://eu-central-1.aws.edge.axiom.co",
      },
      client,
    );
    expect(badHost.sink).toBeUndefined();
    expect(badHost.warning).toMatch(/hostname/);

    const withUser = createAxiomSinkFromEnv(
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
});
