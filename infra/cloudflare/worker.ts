import { timingSafeEqual } from "node:crypto";
import { resolveNovncTarget } from "../../packages/core/src/node/screen-proxy.js";

interface BucketObject {
  body: ReadableStream;
  httpEtag: string;
  size: number;
}
interface Bucket {
  get(key: string): Promise<BucketObject | null>;
  put(key: string, data: ArrayBuffer, options: { onlyIf: Headers }): Promise<unknown | null>;
  delete(key: string): Promise<void>;
}
interface Env {
  ARTIFACTS: Bucket;
  STORAGE_GATEWAY_TOKEN: string;
  SCREEN_PROXY_SECRET: string;
}
const limit = 64 * 1024 * 1024;
function authorized(request: Request, secret: string) {
  if (!secret || secret.length < 32) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "cadre-edge" });
    if (url.pathname === "/objects") {
      if (!authorized(request, env.STORAGE_GATEWAY_TOKEN))
        return new Response("Unauthorized", { status: 401 });
      const key = url.searchParams.get("key") ?? "";
      if (
        !key.startsWith("spaces/") ||
        key.length > 2048 ||
        key.includes("\\") ||
        [...key].some((c) => c.charCodeAt(0) < 32) ||
        key.split("/").some((p) => !p || p === "." || p === "..")
      )
        return new Response("Invalid key", { status: 400 });
      if (request.method === "GET") {
        const object = await env.ARTIFACTS.get(key);
        if (!object) return new Response(null, { status: 404 });
        if (object.size > limit) return new Response("Object too large", { status: 413 });
        return new Response(object.body, {
          headers: {
            etag: object.httpEtag,
            "content-length": String(object.size),
            "cache-control": "private, no-store",
            "content-type": "application/octet-stream",
          },
        });
      }
      if (request.method === "PUT") {
        const length = Number(request.headers.get("content-length"));
        if (!Number.isSafeInteger(length) || length < 0 || length > limit)
          return new Response("Object too large", { status: 413 });
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > limit) return new Response("Object too large", { status: 413 });
        const onlyIf = new Headers();
        for (const name of ["if-match", "if-none-match"]) {
          const value = request.headers.get(name);
          if (value) onlyIf.set(name, value);
        }
        const result = await env.ARTIFACTS.put(key, bytes, { onlyIf });
        return new Response(null, { status: result ? 204 : 412 });
      }
      if (request.method === "DELETE") {
        await env.ARTIFACTS.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    }
    if (url.pathname.startsWith("/novnc/remote/")) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const target = resolveNovncTarget(`${url.pathname}${url.search}`, env.SCREEN_PROXY_SECRET);
      if (
        target?.protocol !== "https:" ||
        target.port !== 443 ||
        !target.hostname.endsWith(".modal.host")
      )
        return new Response("Invalid or expired screen capability", { status: 403 });
      const headers = new Headers(request.headers);
      for (const name of [
        "authorization",
        "cookie",
        "host",
        "proxy-authorization",
        "origin",
        "referer",
      ])
        headers.delete(name);
      const upstream = await fetch(`https://${target.hostname}${target.path}`, {
        method: "GET",
        headers,
        redirect: "manual",
      });
      // Returning the original response preserves the Cloudflare WebSocket handle.
      if (upstream.status === 101) return upstream;
      if (upstream.status >= 300 && upstream.status < 400)
        return new Response("Unexpected computer redirect", { status: 502 });
      const outputHeaders = new Headers(upstream.headers);
      for (const name of ["set-cookie", "clear-site-data"]) outputHeaders.delete(name);
      outputHeaders.set("cache-control", "private, no-store");
      outputHeaders.set("referrer-policy", "no-referrer");
      return new Response(upstream.body, { status: upstream.status, headers: outputHeaders });
    }
    return new Response("Not found", { status: 404 });
  },
};
