import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { collectOutboundPilotText, outboundPilotDirective } from "./primary-outbound-handoff.js";

it("accepts only an explicit first-line directive for the addressed sender", () => {
  const directive = "@Source Bot /handoff Review Bot";
  expect(outboundPilotDirective(`${directive}\r\nReview the change.`, "Source Bot")).toEqual({
    recipient: "Review Bot",
    prompt: "Review the change.",
  });
  for (const text of [
    `Quote:\n${directive}\nDo something.`,
    `${directive}\n   `,
    "@Other Bot /handoff Review Bot\nDo something.",
    "@Source Bot /handoff \nDo something.",
  ]) {
    expect(outboundPilotDirective(text, "Source Bot")).toBeUndefined();
  }
});

async function* stream(...events: AgentRuntimeEvent[]) {
  yield* events;
}

async function collect(events: AsyncIterable<AgentRuntimeEvent>) {
  const seen: AgentRuntimeEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

it("buffers finished text without publishing partial text, and redacts split secrets", async () => {
  const result = collectOutboundPilotText(
    stream(
      { type: "text", text: "Brief fixture-" },
      { type: "text", text: "key" },
      { type: "done", text: "Do not use the duplicate final." },
    ),
    ["fixture-key"],
  );
  expect(await collect(result.events())).toEqual([{ type: "done" }]);
  expect(result.result()).toMatch(/^Brief /);
  expect(result.result()).not.toContain("fixture-key");
});

it("refuses incomplete, oversized, and non-text output", async () => {
  const partial = collectOutboundPilotText(stream({ type: "text", text: "not done" }), []);
  await collect(partial.events());
  expect(partial.result).toThrow("Nothing was sent");
  for (const event of [
    { type: "text", text: "x".repeat(8001) },
    { type: "tool", name: "message_bot", args: {}, executionId: "fixture" },
  ] satisfies AgentRuntimeEvent[]) {
    const draft = collectOutboundPilotText(stream(event), []);
    await expect(collect(draft.events())).rejects.toThrow();
    expect(draft.result).toThrow("Nothing was sent");
  }
});
