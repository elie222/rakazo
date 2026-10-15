import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentToolResultContent,
  ConnectorTool,
  SandboxProcessHandle,
} from "@rakazo/adapter-kit";

export const NATIVE_FRAME_BYTES = 1024 * 1024;
/** Inline media is outbound only; native diagnostic/event frames stay small. */
export const NATIVE_INPUT_FRAME_BYTES = 16 * 1024 * 1024;
export const NATIVE_QUEUED_BYTES = 32 * 1024 * 1024;
const MAX_QUEUED_MESSAGES = 256;
const MAX_PENDING_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 30_000;

export interface NativeProtocolChannel {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  send(message: Record<string, unknown>): Promise<void>;
  /** Includes responses, in wire order, as well as notifications and server requests. */
  messages: AsyncIterable<Record<string, unknown>>;
}

export interface NativeProtocolContext {
  request: AgentRunRequest;
  tools: ConnectorTool[];
  prompt: string;
  nativeSessionId?: string;
  usageState?: Record<string, unknown>;
  /** Persist an opaque native identifier only after the engine has established it. */
  onSession(id: string): void | Promise<void>;
  onUsageState?(state: Record<string, unknown>): void;
  signal: AbortSignal;
  emit(event: AgentRuntimeEvent): void;
  callTool(
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<{ text: string; isError: boolean; content?: AgentToolResultContent[] }>;
  setInterrupt(interrupt: () => Promise<void>): void;
}

export class NativeHarnessPaused extends Error {
  constructor() {
    super("Native harness paused for user input.");
    this.name = "NativeHarnessPaused";
  }
}

export function nativeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid native harness protocol object.");
  }
  return value as Record<string, unknown>;
}

export function nativeString(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > NATIVE_FRAME_BYTES) {
    throw new Error("Invalid native harness protocol string.");
  }
  return value;
}

/** Bounded FIFO: the producer cannot allocate indefinitely behind a paused consumer. */
export class NativeEventQueue<T> implements AsyncIterable<T> {
  private readonly items: Array<{ value: T; bytes: number }> = [];
  private queuedBytes = 0;
  private wake?: () => void;
  private ended = false;
  private error?: unknown;

  constructor(
    private readonly limit = MAX_QUEUED_MESSAGES,
    private readonly maxBytes = NATIVE_QUEUED_BYTES,
    private readonly size: (value: T) => number = (value) =>
      Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"),
  ) {}

  push(value: T): void {
    if (this.ended) return;
    const bytes = this.size(value);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.items.length >= this.limit ||
      this.queuedBytes + bytes > this.maxBytes
    )
      throw new Error("Native harness event queue overflow.");
    this.queuedBytes += bytes;
    this.items.push({ value, bytes });
    this.wake?.();
  }

  end(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = this.items.shift();
      if (item !== undefined) {
        this.queuedBytes -= item.bytes;
        yield item.value;
        continue;
      }
      if (this.ended) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/**
 * The only native I/O boundary. No process is launched in the API/worker OS.
 * stderr and upstream error bodies deliberately never enter user-facing diagnostics.
 */
export class NativeJsonlChannel implements NativeProtocolChannel {
  readonly messages = new NativeEventQueue<Record<string, unknown>>();
  private readonly pending = new Map<
    string,
    { resolve(value: Record<string, unknown>): void; reject(error: unknown): void }
  >();
  private nextId = 0;
  private inputBytes = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private readonly pump: Promise<void>;
  private readonly onAbort: () => void;

  constructor(
    private readonly process: SandboxProcessHandle,
    private readonly signal: AbortSignal,
    private readonly jsonrpc = false,
  ) {
    this.onAbort = () => this.fail(new Error("Native harness cancelled."));
    signal.addEventListener("abort", this.onAbort, { once: true });
    this.pump = this.read();
  }

  async send(message: Record<string, unknown>): Promise<void> {
    const cancellation = ["rakazo/interrupt", "turn/interrupt", "cancel"].includes(
      String(message.method),
    );
    if (!cancellation) this.signal.throwIfAborted();
    if (this.stopped && !cancellation) throw new Error("Native harness transport is closed.");
    const data = `${JSON.stringify(this.jsonrpc ? { jsonrpc: "2.0", ...message } : message)}\n`;
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > NATIVE_INPUT_FRAME_BYTES)
      throw new Error("Native harness input exceeds the frame limit.");
    if (this.inputBytes + bytes > NATIVE_QUEUED_BYTES)
      throw new Error("Native harness input queue overflow.");
    this.inputBytes += bytes;
    try {
      await this.process.writeStdin(data);
    } finally {
      this.inputBytes -= bytes;
    }
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new Error("Too many native harness protocol requests.");
    }
    const id = `rakazo-client-${this.nextId++}`;
    let settle!: { resolve(value: Record<string, unknown>): void; reject(error: unknown): void };
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // Attach immediately: cancellation can arrive while writeStdin is pending.
    void response.catch(() => undefined);
    this.pending.set(id, settle);
    const timer = setTimeout(() => {
      this.fail(new Error("Native harness protocol request timed out."));
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    try {
      await this.send({ id, method, params });
      return await response;
    } catch (error) {
      this.pending.delete(id);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  fail(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.messages.end(error);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.fail(new Error("Native harness transport closed."));
      this.signal.removeEventListener("abort", this.onAbort);
      await this.process.terminate();
      await this.pump;
    })();
    return this.closing;
  }

  private async read(): Promise<void> {
    let buffer = "";
    try {
      for await (const event of this.process.events) {
        if (this.stopped) return;
        if (event.type === "stderr") continue;
        if (event.type === "exit") {
          throw new Error(
            event.code === 0
              ? "Native harness exited before the protocol completed."
              : "Native harness process failed.",
          );
        }
        buffer += event.data;
        // Bound the incomplete frame as well as complete frames; no unbounded split().
        while (true) {
          const end = buffer.indexOf("\n");
          if (end === -1) break;
          const line = buffer.slice(0, end).replace(/\r$/, "");
          buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(line, "utf8") > NATIVE_FRAME_BYTES) {
            throw new Error("Native harness output exceeds the frame limit.");
          }
          if (!line.trim()) continue;
          let value: Record<string, unknown>;
          try {
            value = nativeObject(JSON.parse(line));
          } catch {
            throw new Error("Invalid native harness JSON frame.");
          }
          if (value.method === undefined && typeof value.id === "string") {
            const pending = this.pending.get(value.id);
            if (pending) {
              if (value.error !== undefined) {
                pending.reject(new Error("Native harness protocol request failed."));
              } else {
                pending.resolve(nativeObject(value.result));
              }
              this.pending.delete(value.id);
            }
          }
          this.messages.push(value);
        }
        if (Buffer.byteLength(buffer, "utf8") > NATIVE_FRAME_BYTES) {
          throw new Error("Native harness output exceeds the frame limit.");
        }
      }
      if (!this.stopped) throw new Error("Native harness stream ended without a terminal result.");
    } catch (error) {
      this.fail(error);
    }
  }
}
