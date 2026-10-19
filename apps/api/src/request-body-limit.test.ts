import { ATTACHMENT_MAX_BASE64_LENGTH } from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_AUTH_REQUEST_BYTES,
  MAX_RPC_REQUEST_BYTES,
  mountApiRequestBodyLimits,
  requestBodyLimit,
} from "./request-body-limit.js";

function testApp(maxSize: number, parse = vi.fn(async (request: Request) => request.json())) {
  const app = new Hono();
  app.use("/*", requestBodyLimit(maxSize));
  app.post("/parse", async (c) => c.json(await parse(c.req.raw)));
  return { app, parse };
}

describe("API request body limits", () => {
  it("keeps the RPC allowance above the largest supported attachment envelope", () => {
    expect(MAX_RPC_REQUEST_BYTES).toBeGreaterThan(ATTACHMENT_MAX_BASE64_LENGTH);
    expect(MAX_AUTH_REQUEST_BYTES).toBeLessThan(MAX_RPC_REQUEST_BYTES);
  });

  it("mounts the limits on Auth and RPC without intercepting independently bounded routes", async () => {
    const parse = vi.fn(async (request: Request) => request.json());
    const app = new Hono();
    mountApiRequestBodyLimits(app);
    app.post("/api/auth/sign-in/email", async (c) => c.json(await parse(c.req.raw)));
    app.post("/rpc/test", async (c) => c.json(await parse(c.req.raw)));
    app.post("/api/voice/speak", async (c) => c.json(await parse(c.req.raw)));

    const request = (path: string, contentLength: number) =>
      app.request(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(contentLength),
        },
        body: "{}",
      });
    const auth = await request("/api/auth/sign-in/email", MAX_AUTH_REQUEST_BYTES + 1);
    const rpc = await request("/rpc/test", MAX_RPC_REQUEST_BYTES + 1);
    const voice = await request("/api/voice/speak", MAX_RPC_REQUEST_BYTES + 1);

    expect(auth.status).toBe(413);
    expect(rpc.status).toBe(413);
    expect(voice.status).toBe(200);
    expect(parse).toHaveBeenCalledOnce();
  });

  it("rejects an oversized declared body before the route parser", async () => {
    const { app, parse } = testApp(8);
    const response = await app.request("/parse", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "9" },
      body: JSON.stringify({ ok: true }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
    expect(parse).not.toHaveBeenCalled();
  });

  it.each(["", "8.0", "0x8", "invalid"])(
    "rejects invalid declared length %j before the route parser",
    async (contentLength) => {
      const { app, parse } = testApp(8);
      const response = await app.request("/parse", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": contentLength },
        body: "{}",
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
      expect(parse).not.toHaveBeenCalled();
    },
  );

  it("stops an oversized streamed body before the route parser", async () => {
    const cancel = vi.fn();
    const { app, parse } = testApp(8);
    const response = await app.request(
      new Request("http://localhost/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"value":"'));
            controller.enqueue(new TextEncoder().encode('too large"}'));
          },
          cancel,
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
    expect(parse).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("passes bodies at the configured boundary to the route parser", async () => {
    const { app, parse } = testApp(2);
    const response = await app.request("/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(parse).toHaveBeenCalledOnce();
  });
});
