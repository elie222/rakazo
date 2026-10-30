import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { messagingTools } from "./run-tools-messaging.js";

describe("group peer handoffs", () => {
  it("rejects a peer handoff even if the model attempts the hidden tool", async () => {
    const finish = vi.fn((result) => result);
    const ctx = {
      deps: {},
      run: { clientNonce: "local-group-team:root:peer" },
      thread: { groupId: "group" },
    } as unknown as RunContext;
    const call = { args: {}, finish } as unknown as ToolCall;
    const result = await messagingTools.handoff_to_bot!(ctx, call);
    expect(result).toEqual({
      error: "Report your findings to this group. The coordinator handles further delegation.",
    });
    expect(finish).toHaveBeenCalledOnce();
  });
});
