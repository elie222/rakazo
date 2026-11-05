import type { AxiomIngestClient } from "./axiom-sink.js";
import { createServiceLogger } from "./env.js";
import { installLogger } from "./logger.js";
import type { Logger, LogSink } from "./types.js";

const EDGE_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export async function createAxiomSinkFromEnv(
  source: NodeJS.ProcessEnv = process.env,
  client?: AxiomIngestClient,
): Promise<{ sink?: LogSink; warning?: string }> {
  const token = source.AXIOM_TOKEN?.trim();
  const dataset = source.AXIOM_DATASET?.trim();
  const edge = source.AXIOM_EDGE?.trim() || undefined;
  const edgeUrl = source.AXIOM_EDGE_URL?.trim() || undefined;
  const partial = Boolean(token || dataset || edge || edgeUrl);
  if (token && dataset) {
    const resolved = resolveAxiomEdge(edge, edgeUrl);
    if (resolved.warning) return { warning: resolved.warning };
    // The sink module carries the vendor SDK; an install without Axiom never loads it.
    const { createAxiomSink } = await import("./axiom-sink.js");
    return {
      sink: createAxiomSink({
        token,
        dataset,
        edge: resolved.edge,
        edgeUrl: resolved.edgeUrl,
        client,
      }),
    };
  }
  if (partial) {
    return {
      warning: "Axiom logging is disabled; AXIOM_TOKEN and AXIOM_DATASET must both be set.",
    };
  }
  return {};
}

export async function createRootLogger(
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Logger> {
  // Both sinks load their SDK only when configured, so a default install loads neither.
  const optional = await Promise.all([
    createAxiomSinkFromEnv(env),
    env.SENTRY_DSN?.trim()
      ? import("./sentry.js").then((sentry) => sentry.createSentrySinkFromEnv(service, env))
      : Promise.resolve<{ sink?: LogSink; warning?: string }>({}),
  ]);
  const logger = createServiceLogger({
    service,
    env,
    extraSinks: optional.flatMap((entry) => (entry.sink ? [entry.sink] : [])),
  });
  for (const entry of optional) {
    if (entry.warning) logger.warn(entry.warning);
  }
  installLogger(logger);
  return logger;
}

function resolveAxiomEdge(
  edge?: string,
  edgeUrl?: string,
): { edge?: string; edgeUrl?: string; warning?: string } {
  if (edgeUrl) {
    let url: URL;
    try {
      url = new URL(edgeUrl);
    } catch {
      return { warning: "Axiom logging is disabled; AXIOM_EDGE_URL is not a valid URL." };
    }
    if (url.protocol !== "https:") {
      return { warning: "Axiom logging is disabled; AXIOM_EDGE_URL must use https." };
    }
    if (url.username || url.password) {
      return { warning: "Axiom logging is disabled; AXIOM_EDGE_URL must not include credentials." };
    }
    return { edgeUrl: url.toString().replace(/\/$/, "") };
  }
  if (edge) {
    if (edge.includes("://") || edge.includes("/") || edge.includes("@") || !EDGE_HOST.test(edge)) {
      return {
        warning:
          "Axiom logging is disabled; AXIOM_EDGE must be a hostname such as eu-central-1.aws.edge.axiom.co.",
      };
    }
    return { edge };
  }
  return {};
}
