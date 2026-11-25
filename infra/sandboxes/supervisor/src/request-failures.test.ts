import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core/node/secrets-guard";
import {
  createLogger,
  createTestSink,
  getLogger,
  installLogger,
  runWithLogContext,
} from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supervisorApp } from "./index.js";
import { logRequestFailure } from "./request-failures.js";

const mock = vi.hoisted(() => ({ inspect: vi.fn(), exec: vi.fn(), stats: vi.fn() }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

/** One frame of the stream Docker sends back for a command, carrying `text` as its stderr. */
function stderrFrame(text: string) {
  const header = Buffer.alloc(8);
  header[0] = 2;
  header.writeUInt32BE(Buffer.byteLength(text), 4);
  return Buffer.concat([header, Buffer.from(text)]);
}

describe("failed computer requests", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
  });

  it("says on the request's log line why it failed", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-sandbox-supervisor", sinks: [sink] }));
    const stderr = "bash: line 12: fork: Resource temporarily unavailable\n";
    mock.inspect.mockResolvedValue({
      Config: {
        Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
      },
      State: { Running: true },
    });
    mock.exec.mockImplementation(async () => ({
      start: async () => Readable.from([stderrFrame(stderr)]),
      inspect: async () => ({ ExitCode: 1 }),
    }));
    mock.stats.mockResolvedValue({ pids_stats: {}, memory_stats: {} });

    const response = await supervisorApp.request("/computers/computer/screen-mode", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
      body: JSON.stringify({ interactive: false }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: stderr });
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "http.request.completed",
        "http.route": "/computers/:id/screen-mode",
        "http.status": 400,
        error: expect.objectContaining({ message: stderr }),
      }),
    ]);
  });

  it("keeps only the start of an error too long for one line", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-sandbox-supervisor", sinks: [sink] }));
    const message = "fork: Resource temporarily unavailable\n".repeat(40);

    runWithLogContext({}, () => {
      logRequestFailure(new Error(message));
      getLogger().info("next line");
    });

    expect(sink.events[0]?.error?.message).toBe(`${message.slice(0, 500)}…`);
  });
});
