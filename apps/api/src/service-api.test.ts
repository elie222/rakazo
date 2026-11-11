import { ORPCError } from "@orpc/server";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { projectBlocks, rejectionOf } from "./service-api.js";

describe("projectBlocks", () => {
  it("keeps text and questions and drops everything else", () => {
    const blocks = [
      { kind: "text", text: "hello" },
      { kind: "card", lines: [{ k: "secret", v: "value" }] },
      { kind: "ask", text: "Continue?" },
      { kind: "ask", text: "Done?", status: "answered", answer: "hunter2", input: "secret" },
    ] as MessageBlock[];
    expect(projectBlocks(blocks)).toEqual([
      { kind: "text", text: "hello" },
      { kind: "ask", text: "Continue?", status: "pending" },
      { kind: "ask", text: "Done?", status: "answered" },
    ]);
  });
});

describe("rejectionOf", () => {
  it("tells a refusal of the person apart from a missing scope", () => {
    const rejection = rejectionOf(new ORPCError("FORBIDDEN", { message: "Admins only" }));
    expect([rejection.code, rejection.detail]).toEqual(["not_permitted", "Admins only"]);
  });
});
