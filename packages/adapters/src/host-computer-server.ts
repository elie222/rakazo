import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import {
  HOST_COMPUTER_MAX_BYTES,
  HOST_COMPUTER_MAX_FILE_BYTES,
  hostComputerDeadlineMs,
  hostComputerRequest,
} from "./host-computer-protocol.js";

/** No renderer receives the credential. Docker reaches this listener through its host gateway. */
export async function startHostComputerServer(options: {
  root: string;
  token: string;
  port?: number;
  hostname?: string;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error("Invalid local computer credential");
  let enabled = false;
  const active = new Map<
    AbortController,
    { botId: string; runId?: string; method: string } | undefined
  >();
  const provider = new DesktopSandboxProvider({
    root: options.root,
    hostRoots: [homedir()],
    maxFileBytes: HOST_COMPUTER_MAX_FILE_BYTES,
  });
  const secret = Buffer.from(`Bearer ${options.token}`);
  const server = createServer(async (request, response) => {
    const credential = Buffer.from(request.headers.authorization ?? "");
    // Reject browser-origin requests even when they somehow obtain a credential; no CORS.
    if (
      request.headers.origin ||
      credential.length !== secret.length ||
      !timingSafeEqual(credential, secret)
    ) {
      response.writeHead(401).end();
      return;
    }
    if (!enabled) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/computer") {
      response.writeHead(404).end();
      return;
    }
    // Keep four bounded slots for cancellation and shutdown when commands fill execution capacity.
    if (active.size >= 20) {
      response.writeHead(429).end();
      return;
    }
    const controller = new AbortController();
    active.set(controller, undefined);
    controller.signal.addEventListener("abort", () => response.destroy(), { once: true });
    const abort = () => controller.abort();
    response.once("close", abort);
    let heartbeat: NodeJS.Timeout | undefined;
    let timer = setTimeout(abort, 30_000);
    timer.unref();
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > HOST_COMPUTER_MAX_BYTES) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const parsed = hostComputerRequest.safeParse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (!parsed.success) {
        response.writeHead(400).end();
        return;
      }
      if (!enabled || controller.signal.aborted) {
        response.writeHead(403).end();
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(abort, hostComputerDeadlineMs(parsed.data));
      timer.unref();
      const lifecycle =
        parsed.data.method === "cancelRunWork" ||
        parsed.data.method === "stop" ||
        parsed.data.method === "destroy";
      if (!lifecycle && active.size > 16) {
        response.writeHead(429).end();
        return;
      }
      active.set(controller, {
        botId: parsed.data.botId,
        runId: parsed.data.runId,
        method: parsed.data.method,
      });
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
      });
      response.flushHeaders();
      // Quiet commands must keep HTTP clients and intermediaries from timing out between frames.
      heartbeat = setInterval(() => {
        if (!controller.signal.aborted && !response.destroyed)
          response.write(`${JSON.stringify({ heartbeat: true })}\n`);
      }, 30_000);
      heartbeat.unref();
      const context: AdapterContext = {
        operationId: "desktop-host",
        traceId: "desktop-host",
        spaceId: "local",
        userId: "local",
        runId: parsed.data.runId,
        signal: controller.signal,
      };
      for await (const value of dispatch(parsed.data, context)) {
        if (controller.signal.aborted) break;
        if (!response.write(`${JSON.stringify({ value })}\n`))
          await once(response, "drain", { signal: controller.signal });
      }
      if (!controller.signal.aborted) response.end(`${JSON.stringify({ done: true })}\n`);
    } catch (error) {
      let message = "Local computer operation failed";
      if (
        error instanceof Error &&
        (error.message === "Path escapes the computer workspace" ||
          /^computer file exceeds \d+ bytes$/.test(error.message))
      ) {
        message = error.message;
      } else if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        message = "computer file not found";
      }
      if (!response.headersSent) response.writeHead(400);
      if (!response.destroyed) response.end(`${JSON.stringify({ error: message })}\n`);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      active.delete(controller);
      response.removeListener("close", abort);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.hostname ?? "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local computer unavailable");

  // Reconstruct only our own workspace path. Never trust a caller's providerRef or filesystem root.
  function ref(botId: string): ComputerRef {
    const key = createHash("sha256").update(botId).digest("hex");
    return {
      id: `desktop-${key}`,
      botId: key,
      kind: "desktop",
      providerRef: path.join(options.root, "desktop-computers", key),
    };
  }
  async function* dispatch(
    input: HostComputerRequest,
    context: AdapterContext,
  ): AsyncIterable<unknown> {
    const computer = ref(input.botId);
    switch (input.method) {
      case "environment":
        yield await provider.environment();
        break;
      case "provision": {
        const result = await provider.provision({ botId: computer.botId, homePath: "" }, context);
        yield { ...result, botId: input.botId, providerRef: `host:${computer.botId}` };
        break;
      }
      case "isRunning":
        yield await provider.isRunning(computer, context);
        break;
      case "prepare":
        await provider.prepare(computer, context);
        yield null;
        break;
      case "execute":
        if (!(await provider.isRunning(computer, context)))
          throw new Error("Local computer stopped");
        yield* provider.execute(computer, input.command, context);
        break;
      case "workspaceDirectories":
        yield await provider.workspaceDirectories(computer, input.directories, context);
        break;
      case "cancelRunWork":
        await provider.cancelRunWork(computer, computer.id, input.targetRunId, context);
        for (const [controller, work] of active) {
          if (
            work?.method === "execute" &&
            work.botId === input.botId &&
            work.runId === input.targetRunId
          )
            controller.abort();
        }
        yield null;
        break;
      case "listFiles":
        yield await provider.listFiles(computer, input.path, context);
        break;
      case "readFile":
        yield Buffer.from(
          await provider.readFile(computer, input.path, context, {
            maxBytes: input.maxBytes ?? HOST_COMPUTER_MAX_FILE_BYTES,
          }),
        ).toString("base64");
        break;
      case "writeFile":
        await provider.writeFile(computer, {
          ...input.file,
          content: Buffer.from(input.file.content, "base64"),
        });
        yield null;
        break;
      case "exportWorkspace":
        for await (const file of provider.exportWorkspace(computer)) {
          if (file.content.byteLength > HOST_COMPUTER_MAX_FILE_BYTES)
            throw new Error(`computer file exceeds ${HOST_COMPUTER_MAX_FILE_BYTES} bytes`);
          yield { ...file, content: Buffer.from(file.content).toString("base64") };
        }
        break;
      case "snapshot":
        yield await provider.snapshot(computer, context);
        break;
      case "stop":
      case "destroy":
        for (const [controller, work] of active) {
          if (work?.botId === input.botId && controller.signal !== context.signal)
            controller.abort();
        }
        if (input.method === "destroy") await provider.destroy(computer, context);
        else await provider.stop(computer, context);
        yield null;
        break;
    }
  }
  return {
    port: address.port,
    isEnabled: () => enabled,
    setEnabled(value: boolean) {
      enabled = value;
      if (!value) {
        for (const controller of active.keys()) controller.abort();
        provider.cancelAllCommands();
      }
    },
    async close() {
      enabled = false;
      for (const controller of active.keys()) controller.abort();
      provider.cancelAllCommands();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
