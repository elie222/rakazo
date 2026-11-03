import { ORPCError, onError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import {
  SandboxDamagedError,
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
  VoiceAccountError,
} from "@rakazo/adapter-kit";
import { MODEL_IMAGE_INPUT_ERROR } from "@rakazo/core";
import { IsolationError } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import { handleRpcError, logUnexpectedRpcError } from "./app.js";

describe("logUnexpectedRpcError", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  it("stays quiet for an error the router chose to return", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    logUnexpectedRpcError(new ORPCError("BAD_REQUEST", { message: "file is too large" }), [
      "computer",
      "readFile",
    ]);

    expect(sink.events).toEqual([]);
  });

  it("keeps an image send the model cannot read out of error reports", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const rejection = new ORPCError("CONFLICT", {
      message: MODEL_IMAGE_INPUT_ERROR,
      data: { reason: "model_image_input_unsupported" },
    });

    expect(() => handleRpcError(rejection, ["threads", "send"])).not.toThrow();
    expect(sink.events).toEqual([]);
  });

  it("names the procedure and every cause behind an opaque failure", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new Error("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7091"), {
        code: "ECONNREFUSED",
      }),
    });

    logUnexpectedRpcError(error, ["computer", "screenUrl"]);

    expect(sink.events[0]).toMatchObject({
      message: "rpc computer/screenUrl failed",
      error: {
        message: "fetch failed",
        cause: { message: "connect ECONNREFUSED 127.0.0.1:7091" },
      },
    });
  });

  it("keeps a failure after the client disconnected out of error reports", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const client = new AbortController();
    const router = {
      voices: os.handler(() => {
        client.abort("Client connection prematurely closed.");
        throw new Error("Client connection prematurely closed.");
      }),
    };
    const rpc = new RPCHandler(router, {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });

    await rpc.handle(
      new Request("http://localhost/rpc/voices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        signal: client.signal,
      }),
      { prefix: "/rpc", context: {} },
    );

    expect(sink.events.map((event) => [event.level, event.message])).toEqual([
      ["warn", "rpc voices client disconnected"],
    ]);
  });

  it("returns a provider rate limit as too many requests without an error report", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new SandboxRateLimitError({ cause: new Error("HTTP 429, rate_limited") });

    let thrown: unknown;
    try {
      handleRpcError(error, ["computer", "boot"]);
    } catch (failure) {
      thrown = failure;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect(thrown).toMatchObject({ code: "TOO_MANY_REQUESTS", message: error.message });
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "rpc computer/boot computer rate limited",
        reason: "HTTP 429, rate_limited",
      }),
    ]);
  });

  it("returns a computer the provider never started as a retryable 503 without an error report", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new SandboxUnavailableError({ cause: new Error("sandbox did not become ready") });

    let thrown: unknown;
    try {
      handleRpcError(error, ["computer", "boot"]);
    } catch (failure) {
      thrown = failure;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect(thrown).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: error.message });
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "rpc computer/boot computer unavailable",
        reason: "sandbox did not become ready",
      }),
    ]);
  });

  it("returns an unreachable computer provider as a retryable 503 without an error report", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new SandboxUnresponsiveError("Boat API request failed (HTTP 502)");

    let thrown: unknown;
    try {
      handleRpcError(error, ["computer", "screenUrl"]);
    } catch (failure) {
      thrown = failure;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect(thrown).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: new SandboxUnavailableError().message,
    });
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "rpc computer/screenUrl computer unavailable",
        reason: "Boat API request failed (HTTP 502)",
      }),
    ]);
  });

  it("returns a damaged computer's Recover message as a conflict without an error report", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new SandboxDamagedError();

    let thrown: unknown;
    try {
      handleRpcError(error, ["computer", "boot"]);
    } catch (failure) {
      thrown = failure;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect(thrown).toMatchObject({ code: "CONFLICT", status: 409, message: error.message });
    expect(sink.events.map((event) => [event.level, event.message])).toEqual([
      ["warn", "rpc computer/boot computer damaged"],
    ]);
  });

  it("sends a provider rate limit to the client as HTTP 429 with the plain message", async () => {
    installLogger(createLogger({ service: "rakazo-api", sinks: [createTestSink()] }));
    const router = {
      boot: os.handler(() => {
        throw new SandboxRateLimitError({ cause: new Error("HTTP 429, rate_limited") });
      }),
    };
    const rpc = new RPCHandler(router, {
      clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
    });

    const { response } = await rpc.handle(
      new Request("http://localhost/rpc/boot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { prefix: "/rpc", context: {} },
    );

    expect(response?.status).toBe(429);
    expect(await response?.text()).toContain("Too many computer requests. Try again later.");
  });

  it("sends a spent voice provider account to the client as HTTP 402 with its code and no error report", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const router = {
      voices: os.handler(() => {
        throw new VoiceAccountError(
          "VOICE_OUT_OF_CREDIT",
          "OpenAI says this account is out of credit.",
        );
      }),
    };
    const rpc = new RPCHandler(router, {
      clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
    });

    const { response } = await rpc.handle(
      new Request("http://localhost/rpc/voices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { prefix: "/rpc", context: {} },
    );

    expect(response?.status).toBe(402);
    expect(await response?.json()).toMatchObject({
      json: { code: "VOICE_OUT_OF_CREDIT", message: "OpenAI says this account is out of credit." },
    });
    expect(sink.events.map((event) => event.level)).toEqual(["warn"]);
  });

  it("sends a missing or foreign resource to the client as HTTP 404 without an error report", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const router = {
      read: os.handler(() => {
        throw new IsolationError();
      }),
    };
    const rpc = new RPCHandler(router, {
      clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
    });

    const { response } = await rpc.handle(
      new Request("http://localhost/rpc/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { prefix: "/rpc", context: {} },
    );

    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({
      json: { code: "NOT_FOUND", message: "Resource not found" },
    });
    expect(sink.events.map((event) => [event.level, event.message])).toEqual([
      ["warn", "rpc read not found"],
    ]);
  });
});
