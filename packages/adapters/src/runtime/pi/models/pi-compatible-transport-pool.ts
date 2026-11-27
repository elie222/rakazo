import { createHash } from "node:crypto";
import { getCACertificates } from "node:tls";
import { deadlineSignal } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type { Agent, Dispatcher } from "undici";
import type { ResolveHostname } from "../../../network/network-address.js";

/**
 * Drop an unused dispatcher after this idle gap, and cap a server keep-alive
 * hint at the next value. Sockets per origin stay unlimited, so one busy
 * gateway does not queue another call.
 */
const TRANSPORT_IDLE_MS = 30_000;
const TRANSPORT_KEEPALIVE_MAX_MS = 60_000;
/** Distinct origin, proxy and timeout configurations held at once. In-flight entries can exceed it. */
const TRANSPORT_POOL_LIMIT = 32;
/**
 * A gateway often flushes `data: [DONE]` and sends the chunked terminator a
 * moment later. Wait this long for EOF before giving up on the socket.
 */
const UPSTREAM_END_GRACE_MS = 100;

type PooledTransport = {
  dispatcher: Dispatcher;
  users: number;
  lastUsed: number;
  retired: boolean;
  /**
   * Fingerprint of the default CA store when this dispatcher checks certificates.
   * Absent for plain HTTP with no HTTPS proxy, and when certificate checks are off.
   */
  caFingerprint?: string;
  idle?: ReturnType<typeof setTimeout>;
};

/**
 * `getCACertificates("default")` returns the same array until
 * `setDefaultCACertificates` replaces the store. Hashing that bundle is about
 * a tenth of a millisecond, so it runs only when the array identity changes.
 * `NODE_EXTRA_CA_CERTS` and the system roots are already inside this list.
 */
let caSnapshot: readonly string[] | undefined;
let caFingerprint: string | undefined;
/** Trust fingerprint last used for a borrow that checks certificates. */
let pooledCaFingerprint: string | undefined;

/** Verification flag and default CA list captured with a pool key. */
export type GatewayTlsPolicy = {
  rejectUnauthorized: boolean;
  /** Omitted when certificate checks are off, so the dial does not pin a trust store. */
  ca?: readonly string[];
  /** `NODE_TLS_REJECT_UNAUTHORIZED` at capture. The pool key must not read it again. */
  rejectUnauthorizedEnv: string;
};

/** Proxy env captured with a pool key. Empty strings mean unset. */
export type GatewayProxyRoute = {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
  connectByHostname: string;
};

/**
 * Read the process TLS policy once. The socket opens later, after lookup can
 * yield, and must keep this policy rather than whatever the process says then.
 */
export function captureGatewayTlsPolicy(): GatewayTlsPolicy {
  const rejectUnauthorizedEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "";
  if (rejectUnauthorizedEnv === "0") return { rejectUnauthorized: false, rejectUnauthorizedEnv };
  return { rejectUnauthorized: true, rejectUnauthorizedEnv, ca: getCACertificates("default") };
}

/** Read the proxy env once. A later change must not retarget a dispatcher already keyed. */
export function captureGatewayProxyRoute(): GatewayProxyRoute {
  const env = process.env;
  return {
    httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? "",
    httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? "",
    noProxy: env.no_proxy ?? env.NO_PROXY ?? "",
    connectByHostname: env.RAKAZO_PROXY_CONNECT_BY_HOSTNAME_HOSTS ?? "",
  };
}

function fingerprintCertificates(certificates: readonly string[]): string {
  if (certificates === caSnapshot && caFingerprint !== undefined) return caFingerprint;
  const hash = createHash("sha256");
  for (const certificate of certificates) {
    hash.update(certificate);
    hash.update("\0");
  }
  caSnapshot = certificates;
  caFingerprint = hash.digest("hex");
  return caFingerprint;
}

function requestTarget(
  origin: string,
): { protocol: string; hostname: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (hostname.length > 1 && hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  const port =
    Number.parseInt(url.port, 10) ||
    (url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : 0);
  return { protocol: url.protocol, hostname, port };
}

/** Same host and port rules undici uses for NO_PROXY. */
function noProxyBypasses(raw: string, hostname: string, port: number): boolean {
  if (raw === "") return false;
  for (const entry of raw.split(/[,\s]/)) {
    if (entry === "") continue;
    const parsed = noProxyEntry(entry);
    if (parsed.port !== 0 && parsed.port !== port) continue;
    if (parsed.hostname === "*") return true;
    if (!parsed.wildcard && hostname === parsed.hostname) return true;
    if (hostname.endsWith(`.${parsed.hostname}`)) return true;
  }
  return false;
}

function noProxyEntry(entry: string): { hostname: string; port: number; wildcard: boolean } {
  const wildcard = entry.charCodeAt(0) === 42;
  const ipv6 = /^\[(.+)\]:(\d+)$/.exec(entry);
  let hostname = entry;
  let port = 0;
  if (ipv6) {
    hostname = ipv6[1] ?? "";
    port = Number(ipv6[2]);
  } else {
    const unbracketed = entry.replace(/^\[(.+)\]$/, "$1");
    const colonCount = unbracketed.split(":").length - 1;
    const hostPort = colonCount === 1 ? /^(.+):(\d+)$/.exec(unbracketed) : null;
    hostname = hostPort?.[1] ?? unbracketed;
    port = hostPort ? Number(hostPort[2]) : 0;
  }
  hostname = hostname
    .replace(/^\*?\./, "")
    .replace(/^(.+)\.$/, "$1")
    .toLowerCase();
  return { hostname, port, wildcard };
}

/**
 * True when the request dials an HTTPS proxy. A direct route, a NO_PROXY host,
 * and an unset proxy do not. An https origin with no HTTPS_PROXY uses HTTP_PROXY.
 */
export function selectedHttpsProxy(
  origin: string,
  route: "direct" | "proxy",
  proxy: GatewayProxyRoute,
): boolean {
  if (route !== "proxy") return false;
  const target = requestTarget(origin);
  if (!target || noProxyBypasses(proxy.noProxy, target.hostname, target.port)) return false;
  const httpProxy = proxy.httpProxy || undefined;
  const httpsProxy = proxy.httpsProxy || undefined;
  const selected = target.protocol === "https:" ? (httpsProxy ?? httpProxy) : httpProxy;
  if (!selected) return false;
  try {
    return new URL(selected).protocol === "https:";
  } catch {
    return false;
  }
}

/** Empty when this socket does not check certificates, so it stays pooled across CA changes. */
function verifiedCaFingerprint(
  origin: string,
  route: "direct" | "proxy",
  tls: GatewayTlsPolicy,
  proxy: GatewayProxyRoute,
): string {
  if (!tls.rejectUnauthorized || tls.ca === undefined) return "";
  if (!origin.startsWith("https:") && !selectedHttpsProxy(origin, route, proxy)) return "";
  return fingerprintCertificates(tls.ca);
}

const transports = new Map<string, PooledTransport>();
/** Releases a pool slot when the caller drops a response body without reading or cancelling it. */
const abandonedBodies = new FinalizationRegistry<() => void>((releaseAbandoned) => {
  releaseAbandoned();
});
const resolverIds = new WeakMap<ResolveHostname, number>();
let nextResolverId = 1;

function resolverId(resolve: ResolveHostname): number {
  const existing = resolverIds.get(resolve);
  if (existing !== undefined) return existing;
  const id = nextResolverId;
  nextResolverId += 1;
  resolverIds.set(resolve, id);
  return id;
}

export function compatibleTransportLimits(): Pick<
  Agent.Options,
  "keepAliveTimeout" | "keepAliveMaxTimeout"
> {
  return {
    keepAliveTimeout: TRANSPORT_IDLE_MS,
    keepAliveMaxTimeout: TRANSPORT_KEEPALIVE_MAX_MS,
  };
}

/**
 * Identity of one reusable dispatcher. The checked lookup is closed over the
 * resolver and the address policy, so a different resolver, proxy, timeout or
 * origin must not inherit a socket pinned for someone else. The last field is
 * the default CA fingerprint when the gateway or its HTTPS proxy checks
 * certificates, and empty otherwise.
 */
export function compatibleTransportKey(input: {
  origin: string;
  route: "direct" | "proxy";
  allowPrivate: boolean;
  modelStream: boolean;
  connectTimeout: number;
  resolve: ResolveHostname;
  tls: GatewayTlsPolicy;
  proxy: GatewayProxyRoute;
}): string {
  const ca = verifiedCaFingerprint(input.origin, input.route, input.tls, input.proxy);
  return [
    input.route,
    input.origin,
    input.allowPrivate ? "1" : "0",
    input.modelStream ? "stream" : "probe",
    String(input.connectTimeout),
    String(resolverId(input.resolve)),
    input.proxy.httpProxy,
    input.proxy.httpsProxy,
    input.proxy.noProxy,
    input.proxy.connectByHostname,
    input.tls.rejectUnauthorizedEnv,
    ca,
  ].join("\0");
}

/** The last `\0` field of a transport key. Empty means the socket is not tied to a CA store. */
function caFingerprintOf(key: string): string | undefined {
  const fingerprint = key.slice(key.lastIndexOf("\0") + 1);
  return fingerprint === "" ? undefined : fingerprint;
}

/**
 * A changed default trust store must not keep sockets that already passed
 * verification. `close` lets an in-flight body finish and refuses new requests.
 */
function retireChangedCaTransports(fingerprint: string): void {
  if (fingerprint === "" || fingerprint === pooledCaFingerprint) return;
  pooledCaFingerprint = fingerprint;
  for (const [key, held] of [...transports]) {
    if (held.caFingerprint === undefined || held.caFingerprint === fingerprint) continue;
    void retireTransport(key, held, "close");
  }
}

function retireTransport(
  key: string,
  held: PooledTransport,
  shutdown: "destroy" | "close" = "destroy",
): Promise<void> {
  if (held.retired) return Promise.resolve();
  held.retired = true;
  if (held.idle) clearTimeout(held.idle);
  held.idle = undefined;
  if (transports.get(key) === held) transports.delete(key);
  const closed = shutdown === "close" ? held.dispatcher.close() : held.dispatcher.destroy();
  return bestEffort("close compatible gateway transport", closed).then(() => undefined);
}

/** Drop the oldest idle entries until `limit` remain. In-flight entries are kept. */
function evictIdleTransports(limit: number): void {
  while (transports.size > limit) {
    let oldestKey: string | undefined;
    let oldest: PooledTransport | undefined;
    for (const [key, held] of transports) {
      if (held.users > 0 || held.retired) continue;
      if (!oldest || held.lastUsed < oldest.lastUsed) {
        oldest = held;
        oldestKey = key;
      }
    }
    if (!oldestKey || !oldest) return;
    void retireTransport(oldestKey, oldest);
  }
}

export function borrowCompatibleTransport(
  key: string,
  create: () => Dispatcher,
): { dispatcher: Dispatcher; release: (failed: boolean) => Promise<void> } {
  retireChangedCaTransports(caFingerprintOf(key) ?? "");
  let held = transports.get(key);
  if (!held || held.retired) {
    evictIdleTransports(TRANSPORT_POOL_LIMIT - 1);
    held = {
      dispatcher: create(),
      users: 0,
      lastUsed: Date.now(),
      retired: false,
      caFingerprint: caFingerprintOf(key),
    };
    transports.set(key, held);
  }
  if (held.idle) {
    clearTimeout(held.idle);
    held.idle = undefined;
  }
  held.users += 1;
  held.lastUsed = Date.now();
  const current = held;
  let settled = false;
  return {
    dispatcher: current.dispatcher,
    release(failed: boolean) {
      if (settled) return Promise.resolve();
      settled = true;
      if (current.retired) return Promise.resolve();
      current.users -= 1;
      current.lastUsed = Date.now();
      if (current.users > 0) return Promise.resolve();
      // A failed connect can leave the client stuck dialing. Drop it when nobody
      // else is using it. A finished response stays until the idle gap, and the
      // cap is applied as soon as this entry becomes idle.
      if (failed || transports.get(key) !== current) {
        const closed = retireTransport(key, current);
        evictIdleTransports(TRANSPORT_POOL_LIMIT);
        return closed;
      }
      evictIdleTransports(TRANSPORT_POOL_LIMIT);
      if (current.retired || transports.get(key) !== current) return Promise.resolve();
      current.idle = setTimeout(() => {
        void retireTransport(key, current);
      }, TRANSPORT_IDLE_MS);
      current.idle.unref();
      return Promise.resolve();
    },
  };
}

/**
 * undici waits one event-loop turn before it will write another request on a
 * keep-alive socket. Resolving sooner makes the next call open a second socket.
 */
function onceImmediate(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function hasSubstantialPayload(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 9 && byte !== 10 && byte !== 13 && byte !== 32) return true;
  }
  return false;
}

type UpstreamRead = { ok: true; value: ReadableStreamReadResult<Uint8Array> } | { ok: false };

/**
 * True when the upstream body reaches EOF inside the grace window. Whitespace
 * keeps the wait going. A payload, a read error, or the deadline ends it.
 * A result that already arrived still counts after the deadline.
 */
async function endedAfter(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stop: AbortSignal,
  first?: ReadableStreamReadResult<Uint8Array>,
): Promise<boolean> {
  let pending = first;
  for (;;) {
    let result = pending;
    pending = undefined;
    if (result === undefined) {
      if (stop.aborted) return false;
      const read: Promise<UpstreamRead> = reader.read().then(
        (value) => ({ ok: true, value }),
        () => ({ ok: false }),
      );
      const outcome = await Promise.race([read, whenAborted(stop).then(() => "stop" as const)]);
      if (outcome === "stop") {
        const late = await Promise.race([read, onceImmediate().then(() => "pending" as const)]);
        if (late !== "pending" && late.ok && late.value.done) return true;
        return false;
      }
      if (!outcome.ok) return false;
      result = outcome.value;
    }
    if (result.done) return true;
    if (hasSubstantialPayload(result.value)) return false;
    if (stop.aborted) return false;
  }
}

/**
 * The registry must not keep the wrapped body alive. Build the cleanup in a
 * function that cannot see that body: it closes over the inner reader only.
 * A failed cancel is logged, and the pool slot is released either way.
 */
function abandonedBodyCleanup(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  finish: (failed: boolean) => void,
): () => void {
  return () => {
    void bestEffort(
      "cancel abandoned compatible gateway body",
      reader.cancel().then(() => onceImmediate()),
    ).then(() => finish(false));
  };
}

/**
 * The caller can drop a body without reading or cancelling it. The registry
 * then cancels that body so the pool slot does not stay busy. The token is not
 * the body: the registry holds the token strongly.
 */
function armAbandonedBody(
  body: ReadableStream<Uint8Array>,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  finish: (failed: boolean) => void,
): () => void {
  const token = {};
  abandonedBodies.register(body, abandonedBodyCleanup(reader, finish), token);
  return () => abandonedBodies.unregister(token);
}

type GraceWait = {
  resolve: (ended: boolean) => void;
  stop: AbortSignal;
};

/** Close every pooled gateway dispatcher. Idle sockets are already unref'd; this drops them now. */
export async function closeOpenAiCompatibleTransports(): Promise<void> {
  const entries = [...transports.entries()];
  transports.clear();
  await Promise.all(entries.map(([key, held]) => retireTransport(key, held)));
}

/**
 * Hand the caller a body that releases its pool slot when the body ends, fails,
 * or is cancelled. Dropping the body while no read is waiting does the same.
 * A read that is waiting keeps the body alive until the chunk arrives. `signal`
 * is the caller's request signal. An abort cancels the upstream reader at once.
 * A normal end waits briefly for EOF so undici can put the socket back.
 */
export async function releaseCompatibleResponse(
  response: Response,
  release: (failed: boolean) => Promise<void>,
  signal?: AbortSignal,
): Promise<Response> {
  if (!response.body) {
    await onceImmediate();
    await release(false);
    return response;
  }
  const reader = response.body.getReader();
  let released = false;
  let stopWatching = () => {};
  let activePulls = 0;
  let draining = false;
  let grace: GraceWait | undefined;
  const abortError = (): unknown =>
    signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
  const onAbort = () => {
    // An active pull or cancel already observes the abort and owns the upstream reader.
    if (released || activePulls > 0 || draining) return;
    bestEffort("cancel aborted compatible gateway response", reader.cancel(signal?.reason));
    finish(false);
  };
  const finish = (failed: boolean) => {
    if (released) return;
    released = true;
    signal?.removeEventListener("abort", onAbort);
    stopWatching();
    void release(failed);
  };
  const settleGrace = (ended: boolean) => {
    const pending = grace;
    grace = undefined;
    pending?.resolve(ended);
  };
  // A pull already waiting on the socket owns the next read. Starting another
  // read here throws. The pull reports EOF, a payload, or the deadline.
  function upstreamEnded(caller: AbortSignal | undefined): Promise<boolean> {
    const stop = deadlineSignal(UPSTREAM_END_GRACE_MS, caller);
    if (activePulls === 0) return endedAfter(reader, stop);
    return new Promise((resolve) => {
      let settled = false;
      const resolveOnce = (ended: boolean) => {
        if (settled) return;
        settled = true;
        grace = undefined;
        resolve(ended);
      };
      grace = { resolve: resolveOnce, stop };
      // One turn lets an EOF that already arrived beat the deadline.
      const fail = () => setImmediate(() => resolveOnce(false));
      if (stop.aborted) {
        fail();
        return;
      }
      stop.addEventListener("abort", fail, { once: true });
    });
  }
  // Await the upstream read inside pull. response.text() and a model probe
  // keep no other strong root while they wait for the next chunk, so this
  // read holds the controller. highWaterMark 0 avoids a spare read between
  // chunks, so a dropped body can still be collected then.
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (signal?.aborted) {
          controller.error(abortError());
          finish(false);
          return;
        }
        activePulls += 1;
        try {
          const result = await reader.read();
          if (draining) {
            const stop = grace?.stop;
            if (stop) settleGrace(await endedAfter(reader, stop, result));
            return;
          }
          if (result.done) {
            await onceImmediate();
            if (draining) {
              settleGrace(true);
              return;
            }
            try {
              controller.close();
            } catch (error) {
              // Cancel during this turn already released the dispatcher.
              if (!released) throw error;
            }
            finish(false);
            return;
          }
          controller.enqueue(result.value);
        } catch (error) {
          if (draining) {
            settleGrace(false);
            return;
          }
          try {
            controller.error(error);
          } finally {
            // One body failure drops that socket. The shared dispatcher stays.
            finish(false);
          }
        } finally {
          activePulls -= 1;
        }
      },
      async cancel(reason) {
        draining = true;
        try {
          // The OpenAI SDK cancels its reader after [DONE] without aborting.
          // Aborting, or a body that keeps sending, must not wait out the grace.
          const ended = signal?.aborted ? false : await upstreamEnded(signal);
          if (ended) await onceImmediate();
          else await reader.cancel(reason);
        } finally {
          finish(false);
        }
      },
    },
    { highWaterMark: 0 },
  );
  stopWatching = armAbandonedBody(stream, reader, finish);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
