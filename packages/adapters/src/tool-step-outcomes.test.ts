import { appendToolCallSegment } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import type { ReplyState } from "./run-context.js";
import { redactBlocks } from "./run-messages.js";
import { withReplyToolOutcomes } from "./run-progress.js";
import { toolCompletionOutcome } from "./tool-completion-audit.js";
import {
  historyReplaysOutsideContent,
  keepToolStepResult,
  keptToolArguments,
  keptToolResult,
  TOOL_CALL_TEXT_MAX_CHARS,
  TOOL_REPLY_RESULTS_MAX_CHARS,
} from "./tool-step-calls.js";

const base = { name: "shell", executionId: "call-1", durationMs: 5 };

describe("tool step outcomes", () => {
  it("reads success, a thrown or reported error, and a pause from a completion", () => {
    expect(toolCompletionOutcome({ ...base, result: { content: [] } })).toBe("succeeded");
    expect(toolCompletionOutcome({ ...base, error: new Error("boom") })).toBe("failed");
    expect(
      toolCompletionOutcome({
        ...base,
        result: { content: [{ type: "text", text: "no" }], details: { isError: true } },
      }),
    ).toBe("failed");
    expect(toolCompletionOutcome({ ...base, paused: true })).toBeUndefined();
  });

  it("fails a command that ran but exited non-zero", () => {
    const shell = (code: number) => ({ ...base, result: { stdout: "", stderr: "x", code } });
    expect(toolCompletionOutcome(shell(0))).toBe("succeeded");
    expect(toolCompletionOutcome(shell(1))).toBe("failed");
    expect(toolCompletionOutcome(shell(127))).toBe("failed");
    expect(
      toolCompletionOutcome({ ...base, result: { content: [], details: { exitCode: 2 } } }),
    ).toBe("failed");
  });

  it("saves each call's outcome on its step, and counts unfinished calls when stopped", () => {
    const reply = {
      messageSegments: appendToolCallSegment(appendToolCallSegment([], "shell"), "shell"),
      toolCalls: [
        { label: "Shell", executionId: "call-1" },
        { label: "Shell", executionId: "call-2" },
      ],
      toolOutcomes: new Map([["call-1", "succeeded" as const]]),
      toolStepCalls: new Map(),
      keptResultChars: 0,
    } as unknown as ReplyState;
    expect(withReplyToolOutcomes(reply)).toEqual([
      {
        kind: "steps",
        steps: [{ label: "Shell", tool: "shell", count: 2, outcomes: { succeeded: 1 } }],
      },
    ]);
    expect(withReplyToolOutcomes(reply, "stopped")).toEqual([
      {
        kind: "steps",
        steps: [
          { label: "Shell", tool: "shell", count: 2, outcomes: { succeeded: 1, stopped: 1 } },
        ],
      },
    ]);
  });

  it("keeps each call's arguments and the start of its result on its step", () => {
    const reply = {
      messageSegments: appendToolCallSegment(appendToolCallSegment([], "shell"), "shell"),
      toolCalls: [
        { label: "Shell", executionId: "call-1" },
        { label: "Shell", executionId: "call-2" },
      ],
      toolOutcomes: new Map([
        ["call-1", "succeeded" as const],
        ["call-2", "failed" as const],
      ]),
      toolStepCalls: new Map([
        ["call-1", { arguments: keptToolArguments({ command: "ls" }, []) }],
        ["call-2", { arguments: keptToolArguments({ command: "npm -v" }, []) }],
      ]),
      keptResultChars: 0,
    } as unknown as ReplyState;
    keepToolStepResult(
      reply,
      { ...base, result: { content: [{ type: "text", text: '{"stdout":"a\\n","code":0}' }] } },
      [],
    );
    keepToolStepResult(
      reply,
      { ...base, executionId: "call-2", error: new Error("npm: command not found") },
      [],
    );
    expect(withReplyToolOutcomes(reply)).toEqual([
      {
        kind: "steps",
        steps: [
          {
            label: "Shell",
            tool: "shell",
            count: 2,
            calls: [
              { arguments: '{"command":"ls"}', result: '{"stdout":"a\\n","code":0}' },
              { arguments: '{"command":"npm -v"}', result: "npm: command not found", failed: true },
            ],
            outcomes: { succeeded: 1, failed: 1 },
          },
        ],
      },
    ]);
    // A step whose calls are not all kept (a connector call that made several) keeps none.
    reply.toolStepCalls.delete("call-2");
    const [block] = withReplyToolOutcomes(reply);
    expect(block?.kind === "steps" ? block.steps[0]?.calls : "not steps").toBeUndefined();
  });

  it("keeps what a call really was and returned, redacted, bounded to its start and end", () => {
    const args = JSON.parse(
      keptToolArguments(
        {
          command: `curl -H "Authorization: Bearer abc.def" https://x.test?k=run-secret ${"y".repeat(500)}`,
          api_key: "sk-live-123",
          items: Array.from({ length: 50 }, (_, index) => index),
        },
        ["run-secret"],
      )!,
    );
    expect(args.command).not.toContain("run-secret");
    expect(args.command).not.toContain("abc.def");
    // Ordinary arguments are kept whole.
    expect(args.command).toContain("y".repeat(500));
    expect(args.items).toHaveLength(50);
    expect(args.api_key).toBe("[redacted]");
    const long = `token=run-secret ${"a".repeat(5_000)} exit status 0`;
    const result = keptToolResult(
      { ...base, result: { content: [{ type: "text", text: long }] } },
      ["run-secret"],
    )!;
    expect(result).not.toContain("run-secret");
    // A long result keeps its start and its end, and says how much was left out.
    expect(result).toMatch(/^token=\[redacted\]/);
    expect(result).toMatch(/exit status 0$/);
    expect(result).toMatch(/\[\d+ characters not kept\]/);
    expect(result.length).toBeLessThanOrEqual(TOOL_CALL_TEXT_MAX_CHARS + 60);
    // A short result is kept as it was.
    expect(
      keptToolResult({ ...base, result: { content: [{ type: "text", text: "ok" }] } }, []),
    ).toBe("ok");
    // A screenshot keeps only that it was an image; a secret tool's result is not kept.
    expect(
      keptToolResult({ ...base, result: { content: [{ type: "image", data: "x" }] } }, []),
    ).toBe("[image not kept]");
    expect(
      keptToolResult(
        { ...base, name: "generate_secret", result: { content: [{ type: "text", text: "v" }] } },
        [],
      ),
    ).toBeUndefined();
  });

  it("redacts a secret learned later from calls already kept, when the reply is saved", () => {
    const [block] = redactBlocks(
      [
        {
          kind: "steps",
          steps: [
            {
              label: "Shell",
              tool: "shell",
              count: 1,
              calls: [
                {
                  arguments: '{"command":"echo late-secret"}',
                  result: "late-secret",
                  image: { artifactId: "shot" },
                },
              ],
            },
          ],
        },
      ],
      ["late-secret"],
    );
    expect(JSON.stringify(block)).not.toContain("late-secret");
    expect(block?.kind === "steps" && JSON.parse(block.steps[0]!.calls![0]!.arguments!)).toEqual({
      command: "echo [redacted]",
    });
    // The kept screenshot stays with its call.
    expect(block?.kind === "steps" && block.steps[0]!.calls![0]!.image).toEqual({
      artifactId: "shot",
    });
  });

  it("keeps no more than a reply's result budget, then only how later calls ended", () => {
    const reply = { toolStepCalls: new Map(), keptResultChars: 0 } as unknown as ReplyState;
    const big = { content: [{ type: "text", text: "x".repeat(10_000) }] };
    const calls = Math.ceil(TOOL_REPLY_RESULTS_MAX_CHARS / TOOL_CALL_TEXT_MAX_CHARS) + 2;
    for (let index = 0; index < calls; index++) {
      reply.toolStepCalls.set(`call-${index}`, { arguments: "{}" });
      keepToolStepResult(reply, { ...base, executionId: `call-${index}`, result: big }, []);
    }
    const kept = [...reply.toolStepCalls.values()].map((call) => call.result?.length);
    expect(kept.slice(0, 3).every((length) => length! >= TOOL_CALL_TEXT_MAX_CHARS)).toBe(true);
    expect(kept.at(-1)).toBeUndefined();
    expect(reply.toolStepCalls.get(`call-${calls - 1}`)).toEqual({ arguments: "{}" });
    // Each kept result may add its short "characters not kept" marker to its share.
    expect(reply.keptResultChars).toBeLessThanOrEqual(TOOL_REPLY_RESULTS_MAX_CHARS + 100);
  });

  it("starts a run as having read outside content when history replays a kept outside result", () => {
    const reply = (tool: string, call: Record<string, unknown>) => [
      {
        role: "assistant" as const,
        content: "Done.",
        segments: [{ steps: [{ label: "Step", count: 1, tool, calls: [call] }] }],
      },
    ];
    // A fetched page's text could carry injected instructions into the later turn.
    expect(
      historyReplaysOutsideContent(reply("web_fetch", { arguments: "{}", result: "<page text>" })),
    ).toBe(true);
    expect(
      historyReplaysOutsideContent(
        reply("computer_observe", { arguments: "{}", image: { artifactId: "a" } }),
      ),
    ).toBe(true);
    // The bot's own state, or a call with nothing kept, adds no outside text.
    expect(
      historyReplaysOutsideContent(reply("schedule_list", { arguments: "{}", result: "[]" })),
    ).toBe(false);
    expect(historyReplaysOutsideContent(reply("web_fetch", { arguments: "{}" }))).toBe(false);
    expect(historyReplaysOutsideContent([{ role: "user", content: "Hi" }])).toBe(false);
  });
});
