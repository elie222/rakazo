import type { ConnectorTool, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runs/assembly/run-context.js";
import type { ToolCall } from "../runs/tools/run-tool-gate.js";
import { memoryTools } from "../runs/tools/run-tools-memory.js";
import { appendMemoryFact, editMemory, selectMemoryTools } from "./memory-tools.js";

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const allThree = [
  tool("remember"),
  tool("recall_memory"),
  tool("save_memory"),
  tool("forget_memory"),
  tool("reflect_memory"),
  tool("shell"),
];

describe("selectMemoryTools", () => {
  it("keeps native remember and drops semantic memory tools when unconfigured", () => {
    const names = selectMemoryTools(allThree, false, false, false).map((t) => t.name);
    expect(names).toEqual(["remember", "shell"]);
  });

  it("keeps native remember beside semantic memory tools when configured", () => {
    const names = selectMemoryTools(allThree, true, true, true).map((t) => t.name);
    expect(names).toEqual([
      "remember",
      "recall_memory",
      "save_memory",
      "forget_memory",
      "reflect_memory",
      "shell",
    ]);
  });

  it("keeps native remember and drops forget_memory when the provider cannot forget", () => {
    const names = selectMemoryTools(allThree, true, false, true).map((t) => t.name);
    expect(names).toEqual(["remember", "recall_memory", "save_memory", "reflect_memory", "shell"]);
  });

  it("offers reflect_memory only when the provider can reflect", () => {
    const names = selectMemoryTools(allThree, true, true, false).map((t) => t.name);
    expect(names).toEqual(["remember", "recall_memory", "save_memory", "forget_memory", "shell"]);
    expect(selectMemoryTools(allThree, false, true, true).map((t) => t.name)).not.toContain(
      "reflect_memory",
    );
  });

  it("is a no-op for tool lists with no memory tools at all", () => {
    const shellOnly = [tool("shell")];
    expect(selectMemoryTools(shellOnly, false, false, false)).toEqual(shellOnly);
    expect(selectMemoryTools(shellOnly, true, true, true)).toEqual(shellOnly);
  });
});

describe("reflect_memory", () => {
  function reflectWith(reflect: SemanticMemoryProvider["reflect"]) {
    const context = { operationId: "op-1" };
    const ctx = {
      bot: { id: "bot-1" },
      context,
      runId: "run-1",
      state: { tainted: false },
      memory: { semantic: { reflect }, scope: "shared" },
    } as unknown as RunContext;
    const call = { name: "reflect_memory", args: { query: "What does the user prefer?" } };
    return { ctx, context, result: memoryTools.reflect_memory!(ctx, call as unknown as ToolCall) };
  }

  it("asks the provider with the bot and query and returns its answer", async () => {
    const reflect = vi.fn(async () => ({ ok: true as const, value: "They prefer dark mode." }));
    const { ctx, context, result } = reflectWith(reflect);
    await expect(result).resolves.toEqual({ ok: true, value: "They prefer dark mode." });

    expect(ctx.state.tainted).toBe(true);
    expect(reflect).toHaveBeenCalledWith(
      { query: "What does the user prefer?", botId: "bot-1" },
      context,
    );
  });

  it("says so when memory holds no answer", async () => {
    const { result } = reflectWith(async () => ({ ok: true, value: "  " }));
    await expect(result).resolves.toEqual({ ok: true, value: "No relevant memories." });
  });

  it("passes the provider's error through", async () => {
    const { result } = reflectWith(async () => ({ ok: false, error: "Memory is unreachable." }));
    await expect(result).resolves.toEqual({ ok: false, error: "Memory is unreachable." });
  });

  it("refuses when the provider cannot reflect", async () => {
    const { result } = reflectWith(undefined);
    await expect(result).resolves.toEqual({
      error: "This memory provider cannot answer questions from memory.",
    });
  });
});

describe("recall_memory", () => {
  async function recallWith(value: Array<{ memory: string; score: number; external?: true }>) {
    const ctx = {
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { historyCompactedUpToSeq: null, historyCompactionGeneration: 0 },
      context: { operationId: "op-1" },
      memory: { semantic: { recall: async () => ({ ok: true, value }) }, scope: "isolated" },
      state: { tainted: false },
    } as unknown as RunContext;
    const call = { name: "recall_memory", args: { query: "pets" } };
    const result = await memoryTools.recall_memory!(ctx, call as unknown as ToolCall);
    return {
      result,
      tainted: ctx.state.tainted,
    };
  }

  it("taints the run when another app wrote a recalled memory", async () => {
    const value = [
      { memory: "Prefers dark mode.", score: 0.9 },
      { memory: "The dog is named Pixel.", score: 0.8, external: true as const },
    ];
    const { result, tainted } = await recallWith(value);
    expect(result).toEqual({ ok: true, value });
    expect(tainted).toBe(true);
  });

  it("does not promote the bot's own recalled knowledge to a clean source", async () => {
    const { tainted } = await recallWith([{ memory: "Prefers dark mode.", score: 0.9 }]);
    expect(tainted).toBe(true);
  });
});

describe("appendMemoryFact", () => {
  it("keeps existing memory and adds the fact on its own line", () => {
    expect(appendMemoryFact("Save trip files to Drive.\n", "The client is Combient.")).toBe(
      "Save trip files to Drive.\nThe client is Combient.\n",
    );
  });

  it.each(["Berlin\r\nother\n", "  Berlin  \nother\n", "before\n\tBerlin\t\nafter\n"])(
    "preserves whitespace-tolerant single-line duplicates in %j",
    (existing) => {
      expect(appendMemoryFact(existing, "Berlin")).toBe(existing);
    },
  );

  it.each(["Intro.\n\n", "line  \n", "line  ", "line\r\n", "   "])(
    "preserves existing Markdown whitespace in %j when appending",
    (existing) => {
      const separator = existing.endsWith("\n") ? "" : "\n";
      expect(appendMemoryFact(existing, "new fact")).toBe(`${existing}${separator}new fact\n`);
    },
  );

  it("starts an empty document with the fact", () => {
    expect(appendMemoryFact("", "  durable fact  ")).toBe("durable fact\n");
  });

  it("treats the same fact saved on another day as one it already holds", () => {
    const existing = "Prefers mornings. (saved 2026-03-01)\n";
    expect(appendMemoryFact(existing, "Prefers mornings. (saved 2026-03-09)")).toBe(existing);
  });

  it("adds a fact again when it comes with a new end", () => {
    const existing = "Hold sends. (saved 2026-03-01, ends 2026-03-12)\n";
    const renewed = "Hold sends. (saved 2026-03-09, ends 2026-03-30)";
    expect(appendMemoryFact(existing, renewed)).toBe(`${existing}${renewed}\n`);
  });

  it("leaves memory unchanged for a fact it already holds or an empty fact", () => {
    expect(appendMemoryFact("a\ndurable fact\n", "durable fact")).toBe("a\ndurable fact\n");
    expect(appendMemoryFact("a\n", "   ")).toBe("a\n");
  });
});

describe("multiline memory facts", () => {
  it("recognizes a complete block at the beginning, middle, or end", () => {
    for (const existing of [
      "Office:\nBerlin\n",
      "before\nOffice:\nBerlin\nafter\n",
      "before\nOffice:\nBerlin",
    ]) {
      expect(appendMemoryFact(existing, "Office:\nBerlin")).toBe(existing);
    }
  });

  it.each([
    ["Office:\r\nBerlin\r\n", "Office:\nBerlin"],
    ["Office:\nBerlin\n", "Office:\r\nBerlin"],
    ["before\r\nOffice:\r\nBerlin\r\nafter\r\n", "Office:\nBerlin"],
  ])("matches multiline blocks across newline formats", (existing, fact) => {
    expect(appendMemoryFact(existing, fact)).toBe(existing);
  });

  it("does not match partial lines or nonconsecutive lines", () => {
    for (const existing of [
      "Main Office:\nBerlin\n",
      "Office:\nBerlin Mitte\n",
      "Office:\nother\nBerlin\n",
    ]) {
      expect(appendMemoryFact(existing, "Office:\nBerlin")).toBe(`${existing}Office:\nBerlin\n`);
    }
  });
});

describe("editMemory", () => {
  const memory = "# Memory\n- Lives in London.\n- Prefers short replies.\n";
  const add = (content: string) => ({ action: "add" as const, content });
  const replace = (old_text: string, content: string) => ({
    action: "replace" as const,
    old_text,
    content,
  });
  const remove = (old_text: string) => ({ action: "remove" as const, old_text });

  it("appends an added fact", () => {
    expect(editMemory(memory, [add("Works at Combient.")])).toEqual({
      content: `${memory}Works at Combient.\n`,
    });
  });

  it("replaces the whole entry that holds old_text", () => {
    expect(editMemory(memory, [replace("London", "- Lives in Berlin.")])).toEqual({
      content: "# Memory\n- Lives in Berlin.\n- Prefers short replies.\n",
    });
  });

  it("removes the entry that holds old_text", () => {
    expect(editMemory(memory, [remove("short replies")])).toEqual({
      content: "# Memory\n- Lives in London.\n",
    });
  });

  it("prefers a whole entry over one that only contains old_text", () => {
    const doc = "Lives in London. Moved to Berlin.\nLives in London.\n";
    expect(editMemory(doc, [remove("Lives in London.")])).toEqual({
      content: "Lives in London. Moved to Berlin.\n",
    });
  });

  it("matches old_text that differs only in quotes, dashes or spacing", () => {
    const doc = "- Manager\u2019s name \u2014 Priya   Raman\n- Likes tea\n";
    expect(editMemory(doc, [replace("Manager's name - Priya Raman", "- Manager: Tom")])).toEqual({
      content: "- Manager: Tom\n- Likes tea\n",
    });
  });

  it("refuses old_text found in more than one different entry", () => {
    expect(editMemory(memory, [replace("- ", "x")])).toEqual({
      error: expect.stringContaining("more than one"),
      entries: ["- Lives in London.", "- Prefers short replies."],
    });
  });

  it("changes every copy of a repeated entry", () => {
    expect(editMemory("a\nb\na\n", [replace("a", "c")])).toEqual({ content: "c\nb\n" });
  });

  it("matches a multi-line old_text that differs only in spacing", () => {
    const doc = "- Trip:\n  Lisbon \u2014 May\n- Likes tea\n";
    expect(editMemory(doc, [remove("- Trip:\nLisbon - May")])).toEqual({
      content: "- Likes tea\n",
    });
  });

  it("refuses a replace with no new content", () => {
    expect(editMemory(memory, [replace("London", " ")])).toMatchObject({
      error: expect.stringContaining("Use remove"),
    });
  });

  it("answers a missed old_text with the closest entries by shared words", () => {
    const doc = "- Lives in London.\n- Likes green tea.\n- Dog: Biscuit.\n- Tea at 4pm.\n- Runs.\n";
    expect(editMemory(doc, [remove("Enjoys green tea")])).toEqual({
      error: expect.stringContaining("No entry matches"),
      entries: ["- Likes green tea.", "- Tea at 4pm."],
    });
  });

  it("applies every operation or none", () => {
    const result = editMemory(memory, [add("Works at Combient."), remove("Paris")]);
    expect(result).toMatchObject({
      error: expect.stringMatching(/^Operation 2: .*Nothing was saved/),
    });
  });

  it("checks the cap on the result, so one call can make room and add", () => {
    const full = `${"a".repeat(30)}\n`;
    expect(editMemory(full, [add("b".repeat(10))], 32)).toEqual({
      error: expect.stringContaining("10 bytes over the 32-byte limit"),
      entries: ["a".repeat(30)],
    });
    expect(editMemory(full, [remove("aaa"), add("b".repeat(10))], 32)).toEqual({
      content: `${"b".repeat(10)}\n`,
    });
  });

  it("lets a save that shrinks oversized memory through", () => {
    const oversized = `${"a".repeat(40)}\n${"b".repeat(40)}\n`;
    expect(editMemory(oversized, [remove("bbb")], 32)).toEqual({ content: `${"a".repeat(40)}\n` });
  });
});
