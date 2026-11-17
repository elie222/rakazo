import { expect, it } from "vitest";
import { MODEL_CONNECT_CHECK_CONTEXT } from "./model-connect-check.prompt.js";

it("sends the same minimal check request", () => {
  expect(JSON.stringify(MODEL_CONNECT_CHECK_CONTEXT)).toMatchInlineSnapshot(
    `"{"systemPrompt":"Reply with OK.","messages":[{"role":"user","content":"OK?","timestamp":0}],"tools":[{"name":"noop","description":"Does nothing.","parameters":{"type":"object","properties":{}}}]}"`,
  );
});
