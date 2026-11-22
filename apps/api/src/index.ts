import type { Server } from "node:http";
import { createIngressProvider, ingressPort, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { deadlineSignal } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { stopOnShutdownSignals } from "@rakazo/core/node/shutdown-signals";

loadRootEnv();
await unwrapEnvFromKeyManager();

import { serve } from "@hono/node-server";
import { bestEffort, SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { watchEventLoopStalls } from "@rakazo/logging/event-loop";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { RUN_DRAIN_SIGNAL, trackConnections } from "./http/drain.js";
import { inboundOnly } from "./http/inbound-ingress.js";

const logger = await createRootLogger(SERVICE_NAMES.api);
const stopStallWatch = watchEventLoopStalls("api.event_loop_stalled");

try {
  const env = loadEnv();
  const { app, stop, handleUpgrade } = await createApp({ ...env, logger });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.apiHost }, () => {
    logger.info("api listening", { "http.host": env.apiHost, "http.port": env.port });
  });
  // Desktop apps hold an outbound socket so bots can reach the user's own computer.
  if (handleUpgrade) server.on("upgrade", handleUpgrade);

  // A stop that hands runs back is killed 30 seconds after the signal; leave time for stop().
  const drain = trackConnections(server as Server);
  // Outlive the proxy's 2-minute idle reuse, or a request can hit a socket Node just closed.
  (server as Server).keepAliveTimeout = 125_000;

  // Opt-in: a second port that answers only inbound deliveries, for a public tunnel to forward to.
  const ingress = createIngressProvider();
  let drainIngress: ((graceMs: number) => Promise<void>) | undefined;
  if (ingress) {
    const port = ingressPort();
    const ingressServer = serve(
      { fetch: inboundOnly(app.fetch), port, hostname: env.apiHost },
      () => logger.info("inbound listener", { "http.port": port, provider: ingress.describe().id }),
    );
    drainIngress = trackConnections(ingressServer as Server);
    const upstream = process.env.INGRESS_UPSTREAM_URL?.trim() || `http://127.0.0.1:${port}`;
    void bestEffort("publish inbound routes", ingress.publish(upstream, deadlineSignal(30_000)));
  }

  let stopped: Promise<void> | undefined;
  const shutdown = (letRunsFinish: boolean) => {
    // Stopping at once claims no new run, even while ordinary requests finish. One without
    // letRunsFinish that arrives while the runs are draining ends the drain at once.
    if (stopped) {
      if (!letRunsFinish) void stop();
      return stopped;
    }
    stopStallWatch();
    stopped = (async () => {
      const connectionsClosed = Promise.all([drain(20_000), drainIngress?.(20_000)]).then(
        () => undefined,
      );
      await stop({ letRunsFinish, connectionsClosed });
      await logger.flush({ timeoutMs: 2_000 });
    })();
    return stopped;
  };
  stopOnShutdownSignals(() => shutdown(false));
  // Sent only by a deploy that has already started the next API and waits for this one to exit:
  // stop taking requests at once, but let the chat turns running here end first.
  process.on(RUN_DRAIN_SIGNAL, () => void shutdown(true));
} catch (error) {
  logger.error("api startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
}
