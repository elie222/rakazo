import type { Socket } from "node:net";
import { connect } from "node:net";

/** RFC 1928 reply codes, worded for the person reading why a connection failed. */
const REPLY_ERRORS: Record<number, string> = {
  1: "failed",
  2: "was not allowed",
  3: "found no route to the network",
  4: "found no route to the host",
  5: "was refused",
  6: "timed out",
  7: "is not supported",
  8: "used an unsupported address type",
};

export class Socks5Error extends Error {
  constructor(
    message: string,
    readonly reply?: number,
  ) {
    super(message);
    this.name = "Socks5Error";
  }
}

/**
 * A TCP connection to `host:port` through a SOCKS5 proxy without authentication. The host goes to
 * the proxy unresolved, so a tailnet name is resolved by the node, never by this machine's DNS.
 * The returned socket is paused with any early bytes kept, ready to pipe.
 */
export async function socks5Connect(input: {
  proxy: { host: string; port: number };
  host: string;
  port: number;
  signal: AbortSignal;
}): Promise<Socket> {
  const socket = connect({ host: input.proxy.host, port: input.proxy.port });
  socket.setNoDelay(true);
  const abort = () => socket.destroy(new Socks5Error("The connection was cancelled."));
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    if (input.signal.aborted) abort();
    const reader = new SocketReader(socket);
    await onceConnected(socket);
    socket.write(Buffer.from([5, 1, 0]));
    const greeting = await reader.read(2);
    if (greeting[0] !== 5 || greeting[1] !== 0) {
      throw new Socks5Error("The tailnet proxy refused the handshake.");
    }
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address(input.host, input.port)]));
    const head = await reader.read(4);
    if (head[0] !== 5) throw new Socks5Error("The tailnet proxy answered with an invalid reply.");
    const reply = head[1] ?? 1;
    if (reply !== 0) {
      throw new Socks5Error(`The connection ${REPLY_ERRORS[reply] ?? "failed"}.`, reply);
    }
    const kind = head[3];
    const length =
      kind === 1 ? 4 : kind === 4 ? 16 : kind === 3 ? ((await reader.read(1))[0] ?? 0) : -1;
    if (length < 0) throw new Socks5Error("The tailnet proxy answered with an invalid reply.");
    await reader.read(length + 2);
    reader.release();
    return socket;
  } catch (error) {
    socket.destroy();
    throw error instanceof Socks5Error
      ? error
      : new Socks5Error("The tailnet proxy could not be reached.");
  } finally {
    input.signal.removeEventListener("abort", abort);
  }
}

/** Every host goes as a name (ATYP 3); the node parses IP literals itself. */
function address(host: string, port: number): Buffer {
  const name = Buffer.from(host, "ascii");
  if (name.length === 0 || name.length > 255) throw new Socks5Error("The host name is invalid.");
  return Buffer.concat([
    Buffer.from([3, name.length]),
    name,
    Buffer.from([port >> 8, port & 0xff]),
  ]);
}

function onceConnected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

/** Reads exact byte counts during the handshake, then hands any surplus back to the socket. */
class SocketReader {
  private buffered = Buffer.alloc(0);
  private waiting: { size: number; resolve: (bytes: Buffer) => void } | undefined;
  private failure: Error | undefined;
  private readonly onData = (chunk: Buffer) => {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    this.deliver();
  };
  private readonly onClose = () => this.onEnd();
  private readonly onEnd = (error?: Error) => {
    this.failure = error ?? new Socks5Error("The tailnet proxy closed the connection.");
    this.deliver();
  };
  private reject: ((error: Error) => void) | undefined;

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData);
    socket.once("error", this.onEnd);
    socket.once("close", this.onClose);
  }

  read(size: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiting = { size, resolve };
      this.reject = reject;
      this.deliver();
    });
  }

  release(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onEnd);
    this.socket.off("close", this.onClose);
    this.socket.pause();
    if (this.buffered.length > 0) this.socket.unshift(this.buffered);
    this.buffered = Buffer.alloc(0);
  }

  private deliver(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    if (this.buffered.length >= waiting.size) {
      this.waiting = undefined;
      const bytes = this.buffered.subarray(0, waiting.size);
      this.buffered = this.buffered.subarray(waiting.size);
      waiting.resolve(bytes);
    } else if (this.failure) {
      this.waiting = undefined;
      this.reject?.(this.failure);
    }
  }
}
