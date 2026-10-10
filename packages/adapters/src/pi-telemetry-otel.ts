import type { SpanAttributes, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { Attributes, Context, Span, Tracer } from "@opentelemetry/api";
import { ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// Allowlist metadata: unknown attributes (including future Pi payload fields) stay private.
const safeAttributes = new Set([
  "rakazo.bot.id",
  "rakazo.run.id",
  "rakazo.routine.id",
  "pi.ai.operation",
  "pi.ai.provider",
  "pi.ai.model",
  "pi.ai.api",
  "pi.ai.streaming",
  "pi.ai.response.stop_reason",
  "pi.ai.usage.input_tokens",
  "pi.ai.usage.output_tokens",
  "pi.ai.usage.cache_read_tokens",
  "pi.ai.usage.cache_write_tokens",
  "pi.ai.usage.reasoning_tokens",
  "pi.ai.usage.total_tokens",
  "pi.ai.usage.cost",
  "pi.agent.tool.name",
  "pi.agent.tool.success",
]);
const contentAttributes = new Set([
  "pi.ai.prompt",
  "pi.ai.response",
  "pi.agent.tool.arguments",
  "pi.agent.tool.result",
]);

function attributes(values: SpanAttributes = {}, captureContent: boolean): Attributes {
  return Object.fromEntries(
    Object.entries(values)
      .filter(
        ([key, value]) =>
          value !== undefined &&
          (safeAttributes.has(key) || (captureContent && contentAttributes.has(key))),
      )
      .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  ) as Attributes;
}

/** Explicit parent contexts preserve concurrent run/tool hierarchy without global registration. */
export function otelPiContext(
  tracer: Tracer,
  captureContent: boolean,
  ids: SpanAttributes = {},
  parent: Context = ROOT_CONTEXT,
): TelemetryContext {
  return {
    async startSpan(options, callback) {
      const correlation = {
        ...ids,
        ...Object.fromEntries(
          Object.entries(options.attributes ?? {}).filter(([key]) => key.startsWith("rakazo.")),
        ),
      };
      const span: Span = tracer.startSpan(
        options.name,
        { attributes: attributes({ ...options.attributes, ...correlation }, captureContent) },
        parent,
      );
      const child = otelPiContext(tracer, captureContent, correlation, trace.setSpan(parent, span));
      const bridge: TelemetrySpan = {
        ...child,
        addEvent: (name, values) => {
          span.addEvent(name, attributes(values, captureContent));
        },
        setAttributes: (values) => {
          span.setAttributes(attributes(values, captureContent));
        },
        setStatus: (status) => {
          span.setStatus({
            code: status.status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
          });
        },
      };
      try {
        return await callback(bridge);
      } catch (error) {
        // Exception messages/stacks may contain prompts, credentials or tool arguments.
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  };
}

export function createPiTelemetryExporter() {
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME?.trim() || "rakazo-worker",
    }),
    // The exporter honors standard OTLP endpoint and header env vars, including /v1/traces.
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter(), { exportTimeoutMillis: 2_000 }),
    ],
  });
  return {
    context: otelPiContext(
      provider.getTracer("rakazo.pi", "0.87.1"),
      process.env.OTEL_CAPTURE_CONTENT === "true",
    ),
    shutdown: () => provider.shutdown(),
  };
}
