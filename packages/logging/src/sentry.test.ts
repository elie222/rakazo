import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { createSentrySink, createSentrySinkFromEnv, sentryConfigFromEnv } from "./sentry.js";

const DSN = "https://publickey@errors.example.com/7";

function recordingTransport() {
  const events: Array<Record<string, any>> = [];
  const transport = (options: Parameters<typeof Sentry.createTransport>[0]) =>
    Sentry.createTransport(options, async (request) => {
      const body =
        typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body);
      const lines = body.split("\n");
      for (let index = 1; index < lines.length - 1; index += 2) {
        if (JSON.parse(lines[index]!).type === "event") events.push(JSON.parse(lines[index + 1]!));
      }
      return { statusCode: 200 };
    });
  return { events, transport };
}

afterEach(async () => {
  await Sentry.close();
});

describe("sentry sink", () => {
  it("reads config from the environment", () => {
    expect(sentryConfigFromEnv({})).toEqual({});
    expect(sentryConfigFromEnv({ SENTRY_DSN: "  " })).toEqual({});
    expect(sentryConfigFromEnv({ SENTRY_DSN: "https://errors.example.com/7" }).warning).toContain(
      "not a valid DSN",
    );
    expect(sentryConfigFromEnv({ SENTRY_DSN: "not a dsn" }).warning).toBeDefined();
    expect(
      sentryConfigFromEnv({
        SENTRY_DSN: DSN,
        SENTRY_ENVIRONMENT: " prod-acme ",
        GIT_SHA: "abc123",
      }),
    ).toEqual({ config: { dsn: DSN, environment: "prod-acme", release: "abc123" } });
    expect(
      sentryConfigFromEnv({ SENTRY_DSN: DSN, SENTRY_RELEASE: "v1", GIT_SHA: "abc" }).config
        ?.release,
    ).toBe("v1");
    expect(sentryConfigFromEnv({ SENTRY_DSN: DSN, GIT_SHA: "unknown" }).config?.release).toBe(
      undefined,
    );
    expect(createSentrySinkFromEnv({ SENTRY_DSN: "bad" }).sink).toBeUndefined();
  });

  it("reports error logs with the exception chain, tags, and redacted extras", async () => {
    const { events, transport } = recordingTransport();
    const sink = createSentrySink(
      { dsn: DSN, environment: "prod-acme", release: "abc" },
      transport,
    );
    const logger = createLogger({ service: "rakazo-worker", sinks: [sink] });
    const error = new Error("run failed", { cause: new TypeError("bad input") });
    logger.error("job crashed", error, { jobId: "j1", apiKey: "sk-secret" });
    await logger.flush();

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      environment: "prod-acme",
      release: "abc",
      level: "error",
      tags: { service: "rakazo-worker", jobId: "j1" },
      extra: { "log.message": "job crashed", jobId: "j1" },
    });
    expect(event.extra.apiKey).toBe("[Redacted]");
    const values = event.exception.values;
    expect(values.map((value: { type: string }) => value.type)).toEqual(["TypeError", "Error"]);
    expect(values[1].stacktrace.frames.at(-1).filename).toContain("sentry.test.ts");
  });

  it("redacts what it copies out when handed an event directly", async () => {
    const { events, transport } = recordingTransport();
    const sink = createSentrySink({ dsn: DSN }, transport);
    sink.write({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "login failed for ada@example.com",
      "service.name": "rakazo-api",
      "request.id": "Bearer abc.def",
      password: "hunter2",
      error: {
        name: "Error",
        message: "token=sk-live-123456789",
        stack: "Error: token=sk-live-123456789",
      },
    });
    await sink.flush?.();

    const event = events[0]!;
    expect(event.extra["log.message"]).toBe("login failed for [Redacted]");
    expect(event.extra.password).toBe("[Redacted]");
    expect(event.tags["request.id"]).toBe("Bearer [Redacted]");
    expect(JSON.stringify(event)).not.toMatch(/hunter2|sk-live|ada@example/);
  });

  it("reports error logs without an error as messages and ignores lower levels", async () => {
    const { events, transport } = recordingTransport();
    const logger = createLogger({
      service: "rakazo-api",
      sinks: [createSentrySink({ dsn: DSN }, transport)],
    });
    logger.info("started");
    logger.warn("slow");
    logger.error("queue unavailable", { "request.id": "req-1" });
    logger.error("mail sync failed");
    await logger.flush();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      level: "error",
      message: "queue unavailable",
      tags: { service: "rakazo-api", "request.id": "req-1" },
    });
    // No synthetic stack: the collector titles and groups these by their message.
    expect(events.map((event) => event.exception)).toEqual([undefined, undefined]);
    expect(events[1]!.message).toBe("mail sync failed");
  });
});
