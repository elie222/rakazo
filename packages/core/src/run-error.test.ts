import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isModelRequiredSendError,
  MODEL_REQUIRED_SEND_ERROR,
  normalizeRunError,
} from "./run-error.js";

describe("normalizeRunError", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-01T00:00:00Z"));
  });
  it("summarizes the weekly OpenRouter key limit without exposing diagnostics", () => {
    const details =
      '403: {"message":"Key limit exceeded (weekly limit). Manage it using https://openrouter.ai/workspaces/default/keys/<long hash> $20.05 of $20.00 used; resets 2026-10-12T00:00:00.000Z.","code":403,"metadata":{"limit_source":"openrouter_key_limit"}}';
    expect(normalizeRunError(details)).toMatchObject({
      summary: "Your OpenRouter key hit its weekly limit. Resets Oct 12.",
      details,
    });
  });

  it.each([
    [
      '{"error":{"message":"Insufficient credits","code":402,"metadata":{"provider_name":"OpenAI"}}}',
      "Your OpenAI reached its credit limit.",
    ],
    [
      '403: {"message":"Monthly spending limit exceeded","metadata":{"reset_at":"2026-11-01T00:00:00Z"}}',
      "Your model provider reached its monthly spending limit. Resets Nov 1.",
    ],
    [
      '429: {"message":"Too many requests"}',
      "Your model provider is rate limiting requests. Try again shortly.",
    ],
    [
      '{"error":{"type":"rate_limit_error","message":"Slow down","metadata":{"provider":"Anthropic"}}}',
      "Your Anthropic is rate limiting requests. Try again shortly.",
    ],
    [
      '401: {"message":"Incorrect API key: sk-fake-placeholder; https://api.openai.com"}',
      "Your OpenAI rejected the API key. Check your connection settings.",
    ],
    [
      '403: {"message":"Unauthorized API key"}',
      "Your model provider rejected the API key. Check your connection settings.",
    ],
    [
      '{"error":{"type":"authentication_error","message":"Invalid key"}}',
      "Your model provider rejected the API key. Check your connection settings.",
    ],
    [
      '404: {"error":{"message":"Model fake-model does not exist"}}',
      "Your model provider could not find the requested model.",
    ],
    [
      '{"error":{"code":"model_not_found"}}',
      "Your model provider could not find the requested model.",
    ],
    ["Request timed out", "Your model provider took too long to respond. Try again."],
    [
      '504: {"message":"Gateway error"}',
      "Your model provider took too long to respond. Try again.",
    ],
    ['403: {"message":"Policy blocked the request"}', "The model provider returned an error."],
    ['404: {"message":"Route not found"}', "The model provider returned an error."],
    [
      "500: {malformed https://example.test/keys/fake-key-id",
      "The model provider returned an error.",
    ],
    ["Something unexpected happened", "The model provider returned an error."],
    [
      "Provider diagnostic: manage https://example.test/keys/fake-key-id; trace fake-trace",
      "The model provider returned an error.",
    ],
    [
      "OpenRouter key limit exceeded (weekly). Manage https://example.test/keys/fake-key-id",
      "Your OpenRouter key hit its weekly limit.",
    ],
    ["", "The model provider returned an error."],
  ])("normalizes %s", (details, summary) => {
    expect(normalizeRunError(details)).toMatchObject({ summary, details });
  });

  it.each([
    '429: {"message":"API key rate limit exceeded"}',
    '403: {"message":"API key rate limit exceeded"}',
    '429: {"error":{"type":"rate_limit_error","message":"API key rate limit exceeded"}}',
  ])("recognizes per-key rate limits: %s", (details) => {
    expect(normalizeRunError(details).summary).toBe(
      "Your model provider is rate limiting requests. Try again shortly.",
    );
  });

  it.each([
    "The tools finished, but the model did not write a final answer. Rephrase the request and try again.",
    "Stopped. This stayed queued without starting.",
  ])("preserves app-authored recovery advice: %s", (details) => {
    expect(normalizeRunError(details)).toMatchObject({ summary: details, details });
  });

  it("keeps quota exhaustion distinct from 429 rate limits", () => {
    expect(
      normalizeRunError(
        '429: {"error":{"type":"rate_limit_error","code":"insufficient_quota","message":"Insufficient quota"}}',
      ).summary,
    ).toBe("Your model provider reached its credit limit.");
  });

  it("translates templates and formats reset dates in the selected locale", () => {
    const translate = (message: string, values?: Record<string, string | number>) => {
      const template =
        (
          {
            "Your model provider": "Dein Modellanbieter",
            "{provider} key hit its weekly limit.":
              "{provider}: wöchentliches Schlüssellimit erreicht.",
            "{summary} Resets {date}.": "{summary} Zurückgesetzt am {date}.",
          } as Record<string, string>
        )[message] ?? message;
      return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key]));
    };
    const resetDate = new Intl.DateTimeFormat("de", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date("2026-10-12T00:00:00Z"));
    expect(
      normalizeRunError(
        '403: {"message":"Key limit exceeded (weekly); resets 2026-10-12"}',
        translate,
        "de",
      ).summary,
    ).toBe(
      `Dein Modellanbieter: wöchentliches Schlüssellimit erreicht. Zurückgesetzt am ${resetDate}.`,
    );
  });

  it("ignores malformed reset dates", () => {
    expect(
      normalizeRunError('403: {"message":"Key limit exceeded; resets not-a-date"}').summary,
    ).toBe("Your model provider key hit its limit.");
  });
});

it.each(["2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z", "not-a-date"])(
  "does not promise a past or invalid reset: %s",
  (reset) => {
    expect(
      normalizeRunError(
        `403: {"message":"OpenRouter weekly key limit exceeded", "metadata":{"reset_at":"${reset}"}}`,
        undefined,
        "en",
        Date.parse("2026-10-20T00:00:00Z"),
      ).summary,
    ).toBe("Your OpenRouter key hit its weekly limit.");
  },
);
it("keeps a future reset and identifies recovery", () => {
  expect(
    normalizeRunError(
      '403: {"message":"OpenRouter weekly key limit exceeded; resets 2026-10-21T00:00:00Z"}',
      undefined,
      "en",
      Date.parse("2026-10-20T00:00:00Z"),
    ),
  ).toMatchObject({
    summary: "Your OpenRouter key hit its weekly limit. Resets Oct 21.",
    recovery: "connection",
  });
  expect(normalizeRunError('401: {"message":"Invalid API key"}').recovery).toBe("connection");
  expect(normalizeRunError('429: {"message":"Too many requests"}').recovery).toBe("connection");
  expect(normalizeRunError('500: {"message":"Internal error"}').recovery).toBeUndefined();
});

it.each([
  "Daily request limit exceeded",
  "Weekly request limit exceeded",
  "Per-minute quota exceeded",
])("keeps request quotas as rate limits: %s", (message) => {
  expect(normalizeRunError(`429: ${JSON.stringify({ message })}`)).toMatchObject({
    summary: "Your model provider is rate limiting requests. Try again shortly.",
    recovery: "connection",
  });
});
it.each(["Insufficient credit balance", "Monthly spending limit exceeded"])(
  "keeps financial 429 failures as quota errors: %s",
  (message) => {
    expect(normalizeRunError(`429: ${JSON.stringify({ message })}`).summary).not.toContain(
      "rate limiting",
    );
  },
);

it.each(["2026-02-29", "2026-02-30", "2026-04-31", "2026-02-30T12:00:00Z"])(
  "does not roll an invalid calendar reset forward: %s",
  (reset) => {
    expect(
      normalizeRunError(
        `403: ${JSON.stringify({ message: "OpenRouter weekly key limit exceeded", metadata: { reset_at: reset } })}`,
        undefined,
        "en",
        Date.parse("2026-01-01T00:00:00Z"),
      ).summary,
    ).toBe("Your OpenRouter key hit its weekly limit.");
  },
);
it("retains a valid future leap-day reset", () => {
  expect(
    normalizeRunError(
      '403: {"message":"OpenRouter weekly key limit exceeded; resets 2028-02-29"}',
      undefined,
      "en",
      Date.parse("2028-02-28T00:00:00Z"),
    ).summary,
  ).toBe("Your OpenRouter key hit its weekly limit. Resets Feb 29.");
});

it.each([
  ["403: OpenRouter weekly key limit exceeded", "key", "weekly"],
  ["402: Monthly spending limit exceeded", "spending", "monthly"],
  ["429: insufficient_quota", "credit", "none"],
  ["429: Too many requests", "rate", undefined],
  ["401: Invalid API key", "auth", undefined],
  ["404: Model unavailable", "model", undefined],
])("exposes shared cause metadata for %s", (details, kind, period) => {
  const error = normalizeRunError(details);
  expect(error.kind).toBe(kind);
  expect(error.period).toBe(period);
});

describe("isModelRequiredSendError", () => {
  it.each([
    MODEL_REQUIRED_SEND_ERROR,
    `  ${MODEL_REQUIRED_SEND_ERROR}\n`,
    new Error(MODEL_REQUIRED_SEND_ERROR),
    { message: MODEL_REQUIRED_SEND_ERROR },
  ])("recognizes the exact message in %s", (error) => {
    expect(isModelRequiredSendError(error)).toBe(true);
  });
  it.each([
    null,
    undefined,
    4,
    {},
    { message: 4 },
    "",
    "Connect a model",
    `prefix ${MODEL_REQUIRED_SEND_ERROR}`,
    `${MODEL_REQUIRED_SEND_ERROR} suffix`,
  ])("rejects unrelated values: %s", (error) => {
    expect(isModelRequiredSendError(error)).toBe(false);
  });
});
