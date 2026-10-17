import { ATTACHMENT_MAX_BYTES, attachmentSizeLabel, LOCAL_SETTINGS_RPC } from "@rakazo/contracts";
import type { Hono, MiddlewareHandler } from "hono";
import { cancelBody } from "./http-body.js";

export const MAX_AUTH_REQUEST_BYTES = 64 * 1024;
export const MAX_RPC_REQUEST_BYTES = 16 * 1024 * 1024;

/** Bound JSON entry points before their framework parsers buffer the request. */
export function requestBodyLimit(
  maxSize: number,
  tooLargeMessage = "Request body is too large.",
): MiddlewareHandler {
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
        return c.json({ error: tooLargeMessage }, 413);
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
          return c.json({ error: tooLargeMessage }, 413);
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

/** Allow base64 expansion plus room for the RPC JSON envelope. */
export function rpcRequestMaxBytes(maxUploadSizeBytes = ATTACHMENT_MAX_BYTES): number {
  return Math.max(MAX_RPC_REQUEST_BYTES, Math.ceil(maxUploadSizeBytes / 3) * 4 + 1024 * 1024);
}

/** Install limits only on framework-parsed JSON surfaces with known payload contracts. */
export function mountApiRequestBodyLimits(
  app: Hono,
  maxUploadSizeBytes = ATTACHMENT_MAX_BYTES,
): void {
  app.use("/api/auth/*", requestBodyLimit(MAX_AUTH_REQUEST_BYTES));
  const rpcLimit = requestBodyLimit(
    rpcRequestMaxBytes(maxUploadSizeBytes),
    `Request body is too large. Upload limit: ${attachmentSizeLabel(maxUploadSizeBytes)} per file.`,
  );
  app.use(`${LOCAL_SETTINGS_RPC}/*`, rpcLimit);
  app.use("/rpc/*", rpcLimit);
}
