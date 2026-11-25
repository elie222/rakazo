import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { getLogger } from "@rakazo/logging";
import { stopProcessTree } from "../../cli-models/cli-process.js";

/** A JSON-RPC error the agent answered a request with. */
export class AcpRequestError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRequestError";
  }
}

type Message = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
};

export interface AcpConnection {
  request<T = Record<string, unknown>>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): void;
  /** Every line the agent sends, answered or not, resets this clock. */
  lastHeardAt(): number;
  /** Settles when the agent exits or stops answering; the reason says why. */
  readonly exited: Promise<Error>;
  stderrTail(): string;
  stop(): void;
}

export interface AcpHandlers {
  /** A notification from the agent, such as `session/update`. */
  onNotification(method: string, params: Record<string, unknown>): void;
  /** A request from the agent; its result is the answer, a throw answers with an error. */
  onRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
}

const STDERR_TAIL_CHARS = 2_000;
const METHOD_NOT_FOUND = -32601;

/**
 * Starts an agent that speaks the Agent Client Protocol over stdio: newline-delimited JSON-RPC
 * 2.0, the client on our side. The agent leads its own process group, so stopping it also stops
 * whatever it started.
 */
export function startAcpAgent(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
  handlers: AcpHandlers,
): AcpConnection {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
  });
  let heardAt = Date.now();
  let nextId = 1;
  const pending = new Map<
    number,
    { method: string; resolve(value: unknown): void; reject(error: Error): void }
  >();
  let ended: Error | undefined;
  let endConnection: (error: Error) => void = () => {};
  const exited = new Promise<Error>((resolve) => {
    endConnection = (error) => {
      if (ended) return;
      ended = error;
      for (const call of pending.values()) call.reject(error);
      pending.clear();
      resolve(error);
    };
  });
  // An agent that stops reading can answer nothing more, even while it keeps running.
  // An exit or a failed start says more, so it goes first when both happen.
  const inputClosed = () =>
    setImmediate(() => endConnection(new Error("stopped reading its input")));
  child.stdin.on("error", inputClosed);
  child.stdin.once("close", inputClosed);
  child.once("error", (error) => endConnection(error));
  child.once("close", (code, signal) =>
    endConnection(new Error(`exited (${signal ?? `exit code ${code ?? "unknown"}`})`)),
  );

  const write = (message: Message) => {
    if (ended || child.stdin.destroyed || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const answer = async (message: Message & { method: string }) => {
    const params = record(message.params);
    try {
      const result = await handlers.onRequest(message.method, params);
      write({ id: message.id, result: result ?? null });
    } catch (error) {
      const code = error instanceof AcpRequestError ? error.code : METHOD_NOT_FOUND;
      write({
        id: message.id,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  void (async () => {
    for await (const line of createInterface({
      input: child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    })) {
      if (!line.trim()) continue;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        // Agents log to stdout by mistake now and then; a stray line is not a message.
        continue;
      }
      if (!message || typeof message !== "object") continue;
      // Only protocol messages count as the agent being alive; stray output does not.
      heardAt = Date.now();
      if (typeof message.method === "string") {
        if (message.id === undefined || message.id === null) {
          try {
            handlers.onNotification(message.method, record(message.params));
          } catch (error) {
            // One malformed update must not end the turn's reading.
            getLogger().warn("The agent CLI sent a notification that could not be read", {
              method: message.method,
              error,
            });
          }
        } else {
          void answer(message as Message & { method: string });
        }
        continue;
      }
      const call = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (!call) continue;
      pending.delete(message.id as number);
      if (message.error) {
        call.reject(
          new AcpRequestError(
            call.method,
            typeof message.error.code === "number" ? message.error.code : 0,
            typeof message.error.message === "string" ? message.error.message : "unknown error",
            message.error.data,
          ),
        );
      } else {
        call.resolve(message.result);
      }
    }
  })().catch((error: unknown) =>
    endConnection(error instanceof Error ? error : new Error(String(error))),
  );

  return {
    request<T>(method: string, params: unknown) {
      if (ended) return Promise.reject(ended);
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
        write({ id, method, params });
      });
    },
    notify(method, params) {
      write({ method, params });
    },
    lastHeardAt: () => heardAt,
    exited,
    stderrTail: () => stderr.trim(),
    stop() {
      stopProcessTree(child);
      endConnection(new Error("stopped"));
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
