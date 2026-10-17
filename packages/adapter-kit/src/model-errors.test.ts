import { describe, expect, it } from "vitest";
import {
  isRetryableProviderUnavailable,
  isTransientModelError,
  TransientModelError,
} from "./model-errors.js";

describe("transient model errors", () => {
  it.each([
    [
      "in-stream overload",
      "Codex error: Our servers are currently overloaded. Please try again later.",
    ],
    ["overloaded status", "529 overloaded_error: Overloaded"],
    [
      "rate limit",
      "429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit",
    ],
    [
      "per-minute quota",
      { status: 429, message: "Quota exceeded for quota metric 'requests' per minute" },
    ],
    ["service unavailable", { status: 503, message: "service unavailable" }],
    ["bad gateway", new Error("502 Bad Gateway")],
    ["empty truncated stream", new Error("Stream ended without finish_reason")],
    ["dropped fetch body", new TypeError("terminated")],
    ["fetch failure", new TypeError("fetch failed")],
    ["connection reset", new Error("read ECONNRESET")],
    ["socket hang up", new Error("socket hang up")],
    ["closed websocket", "WebSocket closed 1006"],
    ["idle stream", "Codex stream idle timeout"],
  ])("treats %s as transient", (_label, error) => {
    expect(isTransientModelError(error)).toBe(true);
  });

  it.each([
    ["usage limit", "You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min."],
    [
      "exhausted quota",
      {
        status: 429,
        message: "You exceeded your current quota, please check your plan and billing details.",
        code: "insufficient_quota",
      },
    ],
    ["billing", { status: 402, message: "provider quota exhausted" }],
    ["credit balance", "Your credit balance is too low to access the API."],
    ["invalid key", { status: 401, message: "invalid_api_key: Incorrect API key provided" }],
    ["forbidden", "403 Forbidden"],
    ["context overflow", "context_length_exceeded: maximum context length is 128000 tokens"],
    ["bad request", { status: 400, message: "Unsupported parameter: temperature" }],
    ["cancellation", new Error("Request was aborted")],
    ["unknown", new Error("Model stream ended without a terminal event")],
  ])("treats %s as permanent", (_label, error) => {
    expect(isTransientModelError(error)).toBe(false);
  });

  it.each([
    "You've reached your 5-hour usage limit.",
    "You’ve reached your 5-hour usage limit.",
    "You've reached your weekly (7-day) usage limit.",
    "You've reached your monthly usage limit.",
    "You've reached your usage limit for this billing cycle.",
  ])("treats the exhausted usage window as permanent: %s", (message) => {
    expect(isTransientModelError({ status: 403, type: "permission_error", message })).toBe(false);
  });

  it("names its error class", () => {
    const error = new TransientModelError("overloaded");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TransientModelError");
    expect(error.message).toBe("overloaded");
  });
});

describe("provider availability classification", () => {
  it.each([
    ["dropped fetch body", new TypeError("terminated"), true],
    [
      "Codex overload",
      new Error("Codex error: Our servers are currently overloaded. Please try again later."),
      true,
    ],
    [
      "HTTP 400 before retry text",
      { status: 400, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "HTTP 401 before retry text",
      { statusCode: 401, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "HTTP 403 before retry text",
      { httpStatus: 403, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "unprocessable input before retry text",
      { status: 422, message: "The request cannot be processed; 429 rate limit" },
      false,
    ],
    [
      "cancellation",
      new Error("user cancelled request; retry after 3301 seconds; 429 rate limit"),
      false,
    ],
    [
      "consent refusal",
      new Error("user declined consent; retry after 3301 seconds; 429 rate limit"),
      false,
    ],
    [
      "Kimi 403 5-hour usage limit",
      {
        status: 403,
        type: "permission_error",
        message:
          "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.",
      },
      true,
    ],
    [
      "Kimi 403 5-hour usage limit, curly apostrophe",
      {
        status: 403,
        type: "permission_error",
        message: "You\u2019ve reached your 5-hour usage limit.",
      },
      true,
    ],
    [
      "Kimi 403 weekly usage limit",
      {
        status: 403,
        type: "permission_error",
        message: "You've reached your weekly (7-day) usage limit.",
      },
      true,
    ],
    [
      "Kimi 403 monthly usage limit",
      {
        status: 403,
        type: "permission_error",
        message: "You've reached your monthly usage limit.",
      },
      true,
    ],
    [
      "Kimi 403 billing-cycle usage limit",
      {
        status: 403,
        type: "permission_error",
        message: "You've reached your usage limit for this billing cycle.",
      },
      true,
    ],
    [
      "HTTP 401 with nested Kimi 403 usage limit",
      {
        status: 401,
        cause: { status: 403, message: "You've reached your monthly usage limit." },
      },
      false,
    ],
    [
      "Kimi 403 monthly usage limit not reached",
      {
        status: 403,
        message: "You have not reached your monthly usage limit; access denied",
      },
      false,
    ],
    [
      "Kimi 401",
      {
        status: 401,
        type: "invalid_authentication_error",
        message: "The API Key appears to be invalid or may have expired.",
      },
      false,
    ],
    [
      "Kimi 403 concurrent request limit",
      {
        status: 403,
        message:
          "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.",
      },
      false,
    ],
    [
      "generic 403 permission_error",
      { status: 403, type: "permission_error", message: "permission denied" },
      false,
    ],
    ["quota exhaustion", { status: 402, message: "provider quota exhausted" }, true],
    ["plain status", new Error("503 provider unavailable"), true],
    ["HTTP server status", new Error("HTTP 500"), true],
    ["context overflow", new Error("context_length_exceeded; retry after 60s"), false],
    ["transient server failure", { status: 503, message: "service unavailable" }, true],
  ])("classifies %s", (_label, error, expected) => {
    expect(isRetryableProviderUnavailable(error)).toBe(expected);
  });
});
