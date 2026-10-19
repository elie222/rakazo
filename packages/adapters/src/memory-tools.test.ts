import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { appendMemoryFact, selectMemoryTools } from "./memory-tools.js";

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const allThree = [
  tool("remember"),
  tool("recall_memory"),
  tool("save_memory"),
  tool("forget_memory"),
  tool("shell"),
];

describe("selectMemoryTools", () => {
  it("keeps native remember and drops semantic memory tools when unconfigured", () => {
    const names = selectMemoryTools(allThree, false).map((t) => t.name);
    expect(names).toEqual(["remember", "shell"]);
  });

  it("keeps semantic memory tools and drops native remember when configured", () => {
    const names = selectMemoryTools(allThree, true).map((t) => t.name);
    expect(names).toEqual(["recall_memory", "save_memory", "forget_memory", "shell"]);
  });

  it("is a no-op for tool lists with no memory tools at all", () => {
    const shellOnly = [tool("shell")];
    expect(selectMemoryTools(shellOnly, false)).toEqual(shellOnly);
    expect(selectMemoryTools(shellOnly, true)).toEqual(shellOnly);
  });
});

describe("appendMemoryFact", () => {
  it("keeps existing memory and adds the fact on its own line", () => {
    expect(appendMemoryFact("Save trip files to Drive.\n", "The client is Combient.")).toBe(
      "Save trip files to Drive.\nThe client is Combient.\n",
    );
  });

  it("starts an empty document with the fact", () => {
    expect(appendMemoryFact("", "  durable fact  ")).toBe("durable fact\n");
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
