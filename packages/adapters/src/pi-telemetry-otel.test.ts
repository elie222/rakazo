import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createPiTelemetryExporter } from "./pi-telemetry-otel.js";

afterEach(() => vi.unstubAllEnvs());

it("exports OTLP/HTTP with standard endpoint, headers and service name on shutdown", async () => {
  const received: Array<{ url?: string; authorization?: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ url: request.url, authorization: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  vi.stubEnv(
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer%20fake-fixture-token");
  vi.stubEnv("OTEL_SERVICE_NAME", "fixture-worker");
  const exporter = createPiTelemetryExporter();
  try {
    await exporter.context.startSpan(
      {
        name: "pi.ai.request",
        attributes: { "pi.ai.model": "fixture", "pi.ai.prompt": "private" },
      },
      async () => {},
    );
    await exporter.shutdown();
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe("/v1/traces");
    expect(received[0]?.authorization).toBe("Bearer fake-fixture-token");
    const payload = JSON.parse(received[0]!.body);
    expect(payload.resourceSpans[0].resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "fixture-worker" },
    });
    expect(received[0]?.body).toContain("pi.ai.request");
    expect(received[0]?.body).not.toMatch(/private|fake-fixture-token/);
  } finally {
    await exporter.shutdown().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
