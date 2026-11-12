import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import type { TailnetDestination } from "@rakazo/contracts";
import { tailnetDestinationKey } from "@rakazo/contracts";
import { Socks5Error, socks5Connect } from "./socks5-client.js";
import type { TailnetNodeHost } from "./tailscale-network.js";

const DEFAULT_START_TIMEOUT_MS = 60_000;
const LOGOUT_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 5_000;
const SOCKET_POLL_MS = 50;
const MAX_DIAGNOSTIC_CHARS = 2_000;

export interface TailscaledNodeHostOptions {
  /** The `tailscaled` and `tailscale` executables. */
  tailscaled: string;
  tailscale: string;
  /**
   * A private directory for node sockets and one-use key files. Keep the path short: each node's
   * control socket lives under it, and Unix socket paths are limited to about 100 bytes.
   */
  runDir: string;
  startTimeoutMs?: number;
}

type RunningNode = {
  child: ChildProcess;
  dir: string;
  socketPath: string;
  proxyPort: number;
  sockets: Set<Socket>;
  exited: Promise<void>;
};

/**
 * Runs each bot node as its own stock `tailscaled` in userspace mode, with in-memory state (so the
 * node is ephemeral), incoming connections blocked, no subnet routes, and a SOCKS5 proxy on
 * loopback that Rakazo dials through. The processes get only PATH and HOME, never the backend's
 * environment.
 */
export class TailscaledNodeHost implements TailnetNodeHost {
  private readonly nodes = new Map<string, RunningNode>();

  constructor(private readonly options: TailscaledNodeHostOptions) {}

  async start(
    node: { nodeId: string; hostname: string; authKey: string },
    signal: AbortSignal,
  ): Promise<void> {
    if (this.nodes.has(node.nodeId)) return;
    const timeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    // A fresh directory per start, so cleanup after an old process never touches a new one.
    const dir = join(this.options.runDir, nodeDirectoryName(node.nodeId));
    await mkdir(this.options.runDir, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    const socketPath = join(dir, "tailscaled.sock");
    const proxyPort = await freeLoopbackPort();
    const child = spawn(
      this.options.tailscaled,
      [
        "--state=mem:",
        "--tun=userspace-networking",
        `--statedir=${dir}`,
        `--socket=${socketPath}`,
        `--socks5-server=127.0.0.1:${proxyPort}`,
        "--port=0",
        "--no-logs-no-support",
      ],
      { env: nodeEnvironment(dir), stdio: ["ignore", "ignore", "pipe"] },
    );
    const diagnostics = collect(child.stderr);
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    const running: RunningNode = { child, dir, socketPath, proxyPort, sockets: new Set(), exited };
    this.nodes.set(node.nodeId, running);
    // A node that crashes or is killed outside stop() leaves nothing behind.
    void exited.then(async () => {
      this.cleanUp(node.nodeId, running);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    try {
      await waitForSocket(socketPath, deadline, signal, exited, diagnostics);
      const keyFile = join(dir, "auth-key");
      await writeFile(keyFile, node.authKey, { mode: 0o600 });
      try {
        await this.cli(
          socketPath,
          [
            "up",
            `--auth-key=file:${keyFile}`,
            `--hostname=${node.hostname}`,
            "--shields-up",
            "--accept-routes=false",
            `--timeout=${Math.max(1, Math.ceil((deadline - Date.now()) / 1000))}s`,
            "--reset",
          ],
          deadline - Date.now(),
          signal,
        );
      } finally {
        await rm(keyFile, { force: true });
      }
    } catch (error) {
      await this.terminate(node.nodeId, running);
      if (signal.aborted) throw error;
      const detail = error instanceof Error ? redact(error.message, node.authKey) : "";
      throw new PrivateNetworkError(
        "unavailable",
        `The bot could not join the tailnet.${detail ? ` ${detail}` : ""}`,
        { cause: error },
      );
    }
  }

  async running(nodeId: string): Promise<boolean> {
    return this.nodes.has(nodeId);
  }

  async dial(nodeId: string, destination: TailnetDestination, signal: AbortSignal) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new PrivateNetworkError("unavailable", "This bot is not on the tailnet.");
    try {
      const socket = await socks5Connect({
        proxy: { host: "127.0.0.1", port: node.proxyPort },
        host: destination.host,
        port: destination.port,
        signal,
      });
      node.sockets.add(socket);
      socket.once("close", () => node.sockets.delete(socket));
      return socket;
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = error instanceof Socks5Error ? error.message : "The connection failed.";
      throw new PrivateNetworkError(
        "unavailable",
        `${tailnetDestinationKey(destination)}: ${reason}`,
        { cause: error },
      );
    }
  }

  async stop(nodeId: string, signal: AbortSignal): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    // Logging out deletes the ephemeral node now, instead of when Tailscale notices it is gone.
    await this.cli(node.socketPath, ["logout"], LOGOUT_TIMEOUT_MS, signal).catch(() => {});
    await this.terminate(nodeId, node);
  }

  /** Stop every node, for shutdown. */
  async stopAll(): Promise<void> {
    const signal = AbortSignal.timeout(LOGOUT_TIMEOUT_MS + KILL_GRACE_MS);
    await Promise.all([...this.nodes.keys()].map((nodeId) => this.stop(nodeId, signal)));
  }

  private async terminate(nodeId: string, node: RunningNode): Promise<void> {
    this.cleanUp(nodeId, node);
    if (node.child.exitCode === null && node.child.signalCode === null) {
      node.child.kill("SIGTERM");
      const killed = await Promise.race([
        node.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), KILL_GRACE_MS).unref()),
      ]);
      if (!killed) node.child.kill("SIGKILL");
    }
    await node.exited;
    await rm(node.dir, { recursive: true, force: true });
  }

  private cleanUp(nodeId: string, node: RunningNode): void {
    if (this.nodes.get(nodeId) === node) this.nodes.delete(nodeId);
    for (const socket of node.sockets) socket.destroy();
    node.sockets.clear();
  }

  private cli(
    socketPath: string,
    args: string[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.tailscale, [`--socket=${socketPath}`, ...args], {
        env: nodeEnvironment(undefined),
        stdio: ["ignore", "ignore", "pipe"],
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))]),
      });
      const diagnostics = collect(child.stderr);
      child.once("error", (error) =>
        reject(new Error(diagnostics() || error.message, { cause: error })),
      );
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(diagnostics() || `tailscale ${args[0]} exited with ${code}`));
      });
    });
  }
}

/** Node ids hold user and bot ids; a hash keeps the directory short and path-safe. */
function nodeDirectoryName(nodeId: string): string {
  const hash = createHash("sha256").update(nodeId).digest("hex").slice(0, 12);
  return `${hash}-${randomBytes(3).toString("hex")}`;
}

function nodeEnvironment(home: string | undefined): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(home ? { HOME: home } : {}),
  };
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("port")),
      );
    });
  });
}

async function waitForSocket(
  path: string,
  deadline: number,
  signal: AbortSignal,
  exited: Promise<void>,
  diagnostics: () => string,
): Promise<void> {
  let done = false;
  void exited.then(() => {
    done = true;
  });
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (done) throw new Error(diagnostics() || "tailscaled stopped while starting.");
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SOCKET_POLL_MS));
  }
  throw new Error("tailscaled did not start in time.");
}

/** The last lines a process wrote to stderr, for a short reason when it fails. */
function collect(stream: Readable | null): () => string {
  let text = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    text = (text + chunk).slice(-MAX_DIAGNOSTIC_CHARS);
  });
  return () => text.trim().split("\n").slice(-3).join(" ").slice(-500);
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}
