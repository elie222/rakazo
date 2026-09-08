import { LOCAL_SETTINGS_RPC } from "@rakazo/contracts";
import type { Hono, MiddlewareHandler } from "hono";
import { cancelBody } from "./http-body.js";

export const MAX_AUTH_REQUEST_BYTES = 64 * 1024;
export const MAX_RPC_REQUEST_BYTES = 16 * 1024 * 1024;

/** Bound JSON entry points before their framework parsers buffer the request. */
export function requestBodyLimit(maxSize: number): MiddlewareHandler {
  if (!Number.isSafeInteger(maxSize) || maxSize <= 0) {
    throw new Error("Request body limit must be a positive integer");
  }
  return async (c, next) => {
    const request = c.req.raw;
    if (!request.body) return next();

    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && !request.headers.has("transfer-encoding")) {
      const declared = /^[0-9]+$/.test(contentLength) ? Number(contentLength) : Number.NaN;
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxSize) {
        cancelBody(request.body);
        return c.json({ error: "Request body is too large." }, 413);
      }
      return next();
    }

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxSize) {
          cancelBody(reader);
          return c.json({ error: "Request body is too large." }, 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    c.req.raw = new Request(request, {
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return next();
  };
}

/** Install limits only on framework-parsed JSON surfaces with known payload contracts. */
export function mountApiRequestBodyLimits(app: Hono): void {
  app.use("/api/auth/*", requestBodyLimit(MAX_AUTH_REQUEST_BYTES));
  app.use(`${LOCAL_SETTINGS_RPC}/*`, requestBodyLimit(MAX_RPC_REQUEST_BYTES));
  app.use("/rpc/*", requestBodyLimit(MAX_RPC_REQUEST_BYTES));
}
