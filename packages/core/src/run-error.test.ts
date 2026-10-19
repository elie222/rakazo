import { describe, expect, it } from "vitest";
import { normalizeRunError } from "./run-error.js";

describe("normalizeRunError", () => {
  it("summarizes the weekly OpenRouter key limit without exposing diagnostics", () => {
    const details =
      '403: {"message":"Key limit exceeded (weekly limit). Manage it using https://openrouter.ai/workspaces/default/keys/<long hash> $20.05 of $20.00 used; resets 2026-10-12T00:00:00.000Z.","code":403,"metadata":{"limit_source":"openrouter_key_limit"}}';
    expect(normalizeRunError(details)).toEqual({
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
    expect(normalizeRunError(details)).toEqual({ summary, details });
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
    expect(normalizeRunError(details)).toEqual({ summary: details, details });
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
