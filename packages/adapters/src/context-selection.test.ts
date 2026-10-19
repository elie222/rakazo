import { describe, expect, it } from "vitest";
import {
  ContextBudgetError,
  ContextCacheTracker,
  estimateContextTokens,
  providerContextPrefix,
  selectContext,
} from "./context-selection.js";

const budget = {
  contextWindow: 2000,
  outputReserve: 200,
  systemPrompt: "Stable instructions",
  tools: [],
};
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
describe("bounded context selection", () => {
  it("accounts for instructions, tools, images and output reserve", () => {
    expect(estimateContextTokens([{ type: "image", data: "base64" }], 1000)).toBeGreaterThan(1000);
    const selected = selectContext([user("current")], { budget, strategy: "retrieval" });
    expect(selected.estimatedInputTokens).toBeLessThan(budget.contextWindow - budget.outputReserve);
    expect(selected.estimatedInputTokens).toBeGreaterThan(estimateContextTokens(user("current")));
  });
  it("does not budget unknown images as zero or count local-only Pi metadata", () => {
    const image = {
      role: "user",
      content: [{ type: "image", data: "a".repeat(10000), mimeType: "image/png" }],
    };
    expect(() => selectContext([image], { budget, strategy: "retrieval" })).toThrow(
      ContextBudgetError,
    );
    expect(
      selectContext([image], { budget: { ...budget, imageTokens: 100 }, strategy: "retrieval" })
        .messages,
    ).toHaveLength(1);
    const decorated = { ...user("request"), privateSessionMetadata: "ignored ".repeat(10000) };
    expect(selectContext([decorated], { budget, strategy: "retrieval" }).estimatedInputTokens).toBe(
      selectContext([user("request")], { budget, strategy: "retrieval" }).estimatedInputTokens,
    );
  });
  it("never substitutes an image estimate for image-shaped tool arguments", () => {
    const args = { type: "image", mimeType: "image/png", data: "a".repeat(10000) };
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "upload", arguments: args }],
    };
    expect(estimateContextTokens(assistant, 100)).toBeGreaterThan(10000);
  });
  it("shortens every result in an indirectly protected tool group and rejects duplicate results", () => {
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
    };
    const result = { role: "toolResult", toolCallId: "call", content: "huge ".repeat(10000) };
    const selected = selectContext([call, result, user("steering")], {
      budget,
      strategy: "retrieval",
      protectedIndexes: [0],
    });
    expect(selected.messages).toHaveLength(3);
    expect(selected.truncatedToolResults).toBe(1);
    expect(() =>
      selectContext([call, result, result, user("steering")], { budget, strategy: "retrieval" }),
    ).toThrow("Duplicate tool result");
  });
  it("preserves actual images while shortening result text and fails if the image alone cannot fit", () => {
    const image = { type: "image", data: "a".repeat(10000), mimeType: "image/png" };
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "capture", arguments: {} }],
    };
    const result = {
      role: "toolResult",
      toolCallId: "call",
      content: [image, { type: "text", text: "large text ".repeat(10000) }],
    };
    expect(() =>
      selectContext([user("objective"), call, result], { budget, strategy: "retrieval" }),
    ).toThrow(ContextBudgetError);
    const selected = selectContext([user("objective"), call, result], {
      budget: { ...budget, imageTokens: 100 },
      strategy: "retrieval",
    });
    expect(JSON.stringify(selected.messages.at(-1)!.content)).toContain(image.data);
    expect(selected.truncatedToolResults).toBe(1);
  });
  it("drops older exchanges while retaining current input and durable protected constraints", () => {
    const history = Array.from({ length: 20 }, (_, index) => user(`exchange ${index}`));
    const selected = selectContext(history, {
      budget,
      strategy: "snapshots",
      recentExchanges: 2,
      protectedIndexes: [0],
    });
    expect(selected.messages).toEqual([history[0], history[18], history[19]]);
    expect(selected.droppedMessages).toBe(17);
  });
  it("retains a warm useful prefix when budget allows, cold selection performs no summary work", () => {
    const history = Array.from({ length: 20 }, (_, index) => user(`exchange ${index}`));
    expect(
      selectContext(history, { budget, strategy: "cache-aware", cacheWarmth: "likely-warm" })
        .messages,
    ).toHaveLength(20);
    expect(
      selectContext(history, {
        budget,
        strategy: "cache-aware",
        cacheWarmth: "likely-cold",
        recentExchanges: 2,
      }).messages,
    ).toHaveLength(2);
  });
  it("drops old tool groups together during long loops", () => {
    const history = [
      user("current objective"),
      ...Array.from({ length: 40 }, (_, index) => [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: `tool-${index}`, name: "read", arguments: {} }],
        },
        { role: "toolResult", toolCallId: `tool-${index}`, content: "result ".repeat(30) },
      ]).flat(),
    ];
    const result = selectContext(history, { budget, strategy: "retrieval" });
    expect(result.messages[0]).toEqual(history[0]);
    expect(result.messages.at(-1)).toEqual(history.at(-1));
    expect(result.droppedMessages).toBeGreaterThan(0);
    for (let index = 1; index < result.messages.length; index += 2) {
      expect(result.messages[index]!.role).toBe("assistant");
      expect(result.messages[index + 1]!.role).toBe("toolResult");
    }
  });
  it("shortens an oversized latest tool result without corrupting tool references", () => {
    const history = [
      user("objective"),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call",
        content: [{ type: "text", text: "large data ".repeat(10000) }],
      },
    ];
    const selected = selectContext(history, { budget, strategy: "retrieval" });
    expect(selected.truncatedToolResults).toBeGreaterThan(0);
    expect(selected.messages[1]).toEqual(history[1]);
    expect(selected.messages[2]).toMatchObject({ toolCallId: "call" });
    expect(selected.estimatedInputTokens).toBeLessThan(budget.contextWindow - budget.outputReserve);
    expect(JSON.stringify(selected.messages[2]!.content)).toContain("Tool result truncated");
  });
  it("shortens history JSON evidence while preserving exact original offsets and pagination", () => {
    const original = 'Quoted "value" and newline\n'.repeat(500);
    const payload = {
      untrusted: true,
      messages: [
        {
          messageId: "anchor",
          text: original.slice(250, 5000),
          textOffset: 250,
          nextTextOffset: 5000,
          truncated: true,
        },
      ],
      nextRunId: "run-cursor",
      nextArtifactId: "artifact-cursor",
      nextOutcomeSeq: 90,
      runs: [],
      snapshots: [],
    };
    const selected = selectContext(
      [
        user("Read original evidence"),
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "history",
              name: "read_history",
              arguments: { messageId: "anchor" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "history",
          content: [{ type: "text", text: JSON.stringify(payload) }],
        },
      ],
      { budget: { ...budget, contextWindow: 4000 }, strategy: "retrieval" },
    );
    const content = selected.messages.at(-1)!.content as Array<{ text: string }>;
    const decoded = JSON.parse(content[0]!.text);
    expect(decoded).toMatchObject({
      nextRunId: "run-cursor",
      nextArtifactId: "artifact-cursor",
      nextOutcomeSeq: 90,
    });
    expect(decoded.messages[0].nextTextOffset).toBe(250 + decoded.messages[0].text.length);
    expect(decoded.messages[0].text).toBe(original.slice(250, decoded.messages[0].nextTextOffset));
    expect(decoded.messages[0].truncated).toBe(true);
    expect(selected.truncatedToolResults).toBe(1);
  });
  it("returns valid retry JSON when history navigation metadata cannot fit", () => {
    const selected = selectContext(
      [
        user("Read original evidence"),
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "history",
              name: "read_history",
              arguments: { messageId: "anchor" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "history",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                untrusted: true,
                messages: Array.from({ length: 100 }, (_, index) => ({
                  messageId: `anchor-${index}`,
                  text: "x",
                  textOffset: 0,
                })),
              }),
            },
          ],
        },
      ],
      { budget, strategy: "retrieval" },
    );
    const content = selected.messages.at(-1)!.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]!.text)).toMatchObject({
      untrusted: true,
      needsRetry: true,
      retry: { messageId: "anchor", limit: 1 },
    });
  });
  it("preserves generic JSON controls and marks omitted diagnostic strings", () => {
    const selected = selectContext(
      [
        user("Read diagnostics"),
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "diagnostic", name: "read_diagnostic", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "diagnostic",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                nextCursor: "segment-2",
                segment: 1,
                approval: "pending",
                diagnostic: 'quoted "value"\n'.repeat(3000),
              }),
            },
          ],
        },
      ],
      { budget, strategy: "retrieval" },
    );
    const content = selected.messages.at(-1)!.content as Array<{ text: string }>;
    const decoded = JSON.parse(content[0]!.text);
    expect(decoded).toMatchObject({
      nextCursor: "segment-2",
      segment: 1,
      approval: "pending",
      contextTruncated: true,
    });
    expect(decoded.diagnostic).toContain("Tool result truncated");
  });
  it("fails explicitly if mandatory content cannot fit rather than silently losing the request", () => {
    expect(() =>
      selectContext([user("large ".repeat(2000))], { budget, strategy: "retrieval" }),
    ).toThrow(ContextBudgetError);
    expect(() =>
      selectContext([{ role: "toolResult", content: "orphan" }], { budget, strategy: "current" }),
    ).toThrow("Orphaned");
  });
});
describe("cache request metadata", () => {
  const request = {
    accountScope: "synthetic-account",
    connectionId: "connection",
    modelId: "model",
    prefix: providerContextPrefix("stable", [], [user("first")]),
    prefixTokens: 2000,
    capabilities: { scope: "account" as const, retentionMs: 300000, minimumTokens: 1000 },
  };
  it("predicts timing with fake clock and matching appended prefixes", () => {
    let time = 0;
    const tracker = new ContextCacheTracker(() => time);
    expect(tracker.predict(request)).toBe("likely-cold");
    tracker.record(request, 1000);
    time = 10000;
    expect(
      tracker.predict({
        ...request,
        prefix: providerContextPrefix("stable", [], [user("first"), user("next")]),
      }),
    ).toBe("likely-warm");
    time = 300000;
    expect(tracker.predict(request)).toBe("likely-cold");
  });
  it("uses request-start time even when completion arrives after retention expires", () => {
    let time = 0;
    const tracker = new ContextCacheTracker(() => time);
    const started = tracker.stamp(request);
    time = 300001;
    tracker.record(started, 1000);
    expect(tracker.predict(request)).toBe("likely-cold");
    const next = tracker.stamp(request);
    time += 100;
    tracker.record(next, 1000);
    expect(tracker.predict({ ...request, startedAt: -99999 })).toBe("likely-warm");
    // A late completion from an older request cannot replace the newer start time.
    tracker.record(started, 0);
    expect(tracker.predict(request)).toBe("likely-warm");
  });
  it("does not retain a warm prediction when caching is explicitly disabled", () => {
    const tracker = new ContextCacheTracker(() => 0);
    const disabled = {
      ...request,
      capabilities: { ...request.capabilities, retentionMode: "none" as const },
    };
    tracker.record(disabled, 1000);
    expect(tracker.predict(disabled)).toBe("likely-cold");
  });
  it("does not treat user activity, model/account changes or changed prefixes as cache hits", () => {
    const tracker = new ContextCacheTracker(() => 0);
    tracker.record(request);
    for (const change of [
      { modelId: "other" },
      { accountScope: "other" },
      { connectionId: "other" },
      { prefix: "changed" },
    ]) {
      expect(tracker.predict({ ...request, ...change })).toBe("likely-cold");
    }
    expect(tracker.predict({ ...request, capabilities: undefined })).toBe("unknown");
  });
  it("ignores transient Pi timestamps in prefix fingerprints", () => {
    expect(providerContextPrefix("stable", [], [user("first")])).toEqual(
      providerContextPrefix("stable", [], [{ ...user("first"), timestamp: 999 }]),
    );
  });
  it("fingerprints transcript instruction sections and tool changes", () => {
    const system = {
      role: "system",
      content: "Stable instructions",
      sections: { approval: "Pending" },
      toolsAdded: [{ name: "read_history", parameters: { type: "object" } }],
      toolsRemoved: [{ name: "old_tool" }],
      timestamp: 1,
    };
    const prefix = providerContextPrefix("", [], [system]);
    expect(prefix).toEqual(providerContextPrefix("", [], [{ ...system, timestamp: 2 }]));
    for (const changed of [
      { ...system, sections: { approval: "Granted" } },
      { ...system, toolsAdded: [] },
      { ...system, toolsRemoved: [] },
    ]) {
      expect(providerContextPrefix("", [], [changed])).not.toEqual(prefix);
    }
  });
  it("records observed cache reuse without pretending unknown measurements are zero", () => {
    const tracker = new ContextCacheTracker(() => 0);
    expect(tracker.record(request)).toEqual({ observedReuse: null });
    expect(tracker.record(request, 0)).toEqual({ observedReuse: false });
    expect(tracker.record(request, 1)).toEqual({ observedReuse: true });
  });
});
