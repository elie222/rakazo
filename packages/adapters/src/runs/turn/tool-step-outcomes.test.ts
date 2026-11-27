import type { HistoryToolStep, RunTrigger } from "@rakazo/contracts";
import { RUN_TRIGGERS } from "@rakazo/contracts";
import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { appendToolCallSegment } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { sanitizeConnectorError } from "../../integrations/connector-safety.js";
import { sanitizeSensitiveText } from "../../runtime/pi/pi-runtime-errors.js";
import type { ReplyState, RunContext } from "../assembly/run-context.js";
import { redactBlocks } from "../assembly/run-messages.js";
import { withReplyToolOutcomes } from "../lifecycle/run-progress.js";
import { toolCompletionOutcome } from "./tool-completion-audit.js";
import {
  bounded,
  historyReplaysOutsideContent,
  keepToolStepResult,
  keptToolArguments,
  keptToolResult,
  keptTurnTranscript,
  runReplaysToolHistory,
  saveLatestStepScreenshot,
  TOOL_CALL_SAVED_TEXT_MAX_CHARS,
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
        steps: [{ label: "Shell", count: 2, outcomes: { succeeded: 1 } }],
      },
    ]);
    expect(withReplyToolOutcomes(reply, "stopped")).toEqual([
      {
        kind: "steps",
        steps: [{ label: "Shell", count: 2, outcomes: { succeeded: 1, stopped: 1 } }],
      },
    ]);
  });

  it("keeps each call's arguments and the start of its result on its step", () => {
    const reply = {
      messageSegments: appendToolCallSegment(appendToolCallSegment([], "shell"), "shell"),
      toolCalls: [
        { label: "Shell", executionId: "call-1", tool: "shell" },
        { label: "Shell", executionId: "call-2", tool: "shell" },
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
    expect(
      block?.kind === "steps" ? (block.steps[0] as HistoryToolStep).calls : "not steps",
    ).toBeUndefined();
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
    expect(
      keptToolResult(
        {
          ...base,
          name: "read_meeting_transcript",
          result: { content: [{ type: "text", text: "Recorded speech" }] },
        },
        [],
      ),
    ).toBeUndefined();
  });

  it("redacts a secret learned later from calls already kept, when the reply is saved", () => {
    const step: HistoryToolStep = {
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
    };
    const [block] = redactBlocks(
      [
        {
          kind: "steps",
          steps: [step],
        },
      ],
      ["late-secret"],
    );
    expect(JSON.stringify(block)).not.toContain("late-secret");
    const [call] = block?.kind === "steps" ? (block.steps[0] as HistoryToolStep).calls! : [];
    expect(JSON.parse(call!.arguments!)).toEqual({
      command: "echo [redacted]",
    });
    // The kept screenshot stays with its call.
    expect(call!.image).toEqual({
      artifactId: "shot",
    });
  });

  it("redacts credentials a tool returned in JSON fields", () => {
    const result = keptToolResult(
      {
        ...base,
        result: {
          content: [
            { type: "text", text: '{"user":"ana","password":"hunter2","api_key":"k-123"}' },
          ],
        },
      },
      [],
    );
    expect(result).toBe('{"user":"ana","password":"[redacted]","api_key":"[redacted]"}');
  });

  it("redacts padded and boundary-straddling secrets before trimming or slicing tool results", () => {
    const paddedSecret = "  res&sec<3>val  ";
    expect(
      keptToolResult({ ...base, result: { content: [{ type: "text", text: paddedSecret }] } }, [
        paddedSecret,
      ]),
    ).toBe("[redacted]");
    expect(
      keptToolResult({ ...base, result: { content: [{ type: "text", text: "   " }] } }, ["  "]),
    ).toBeUndefined();
    expect(
      keptToolResult(
        {
          ...base,
          result: {
            content: [{ type: "text", text: `${" ".repeat(1_500)}ok${" ".repeat(1_500)}` }],
          },
        },
        [],
      ),
    ).toBe("ok");

    const longSecret = `secret-${"z".repeat(280)}-tail`;
    const headBoundary = `${"a".repeat(690)}${longSecret}${"b".repeat(800)}`;
    const boundedResult = keptToolResult(
      { ...base, result: { content: [{ type: "text", text: headBoundary }] } },
      [longSecret],
    )!;
    expect(boundedResult).not.toContain("secret-zzzz");
    expect(boundedResult).toContain("[redacted]");

    const multilineSecret = 'line1\n"quoted"\\val';
    const longJson = JSON.stringify({
      stdout: `got ${multilineSecret}`,
      rest: "x".repeat(1_500),
    });
    const keptJson = keptToolResult(
      { ...base, result: { content: [{ type: "text", text: longJson }] } },
      [multilineSecret],
    )!;
    expect(keptJson).toContain('"stdout":"got [redacted]"');
    expect(keptJson).not.toContain(multilineSecret);
    expect(keptJson).not.toContain(JSON.stringify(multilineSecret).slice(1, -1));

    const bearerJson = keptToolResult(
      {
        ...base,
        result: {
          content: [{ type: "text", text: '{"msg":"Bearer secret-tok\\nNext line","ok":"keep"}' }],
        },
      },
      [],
    )!;
    expect(JSON.parse(bearerJson)).toEqual({
      msg: "Bearer [redacted]\nNext line",
      ok: "keep",
    });

    const windowsDiag = keptToolResult(
      {
        ...base,
        result: {
          content: [
            { type: "text", text: 'Open "C:\\Users\\bob\\Bearer tok999" and "C:\\Users\\sec-1"' },
          ],
        },
      },
      ["sec-1"],
    )!;
    expect(windowsDiag).toBe(
      'Open "C:\\Users\\bob\\Bearer [redacted]" and "C:\\Users\\[redacted]"',
    );

    const slashSecret = "prefix\\";
    const escapedQuoteResult = keptToolResult(
      {
        ...base,
        result: {
          content: [{ type: "text", text: '{"safe":"prefix\\"kept","secret":"prefix\\\\"}' }],
        },
      },
      [slashSecret],
    )!;
    expect(JSON.parse(escapedQuoteResult)).toEqual({
      safe: 'prefix"kept',
      secret: "[redacted]",
    });

    const semicolonSecret = "tok-part;fixture-suffix";
    const failedBearer = keptToolResult(
      { ...base, error: new Error(`Authorization: Bearer ${semicolonSecret}`) },
      [semicolonSecret],
    )!;
    expect(failedBearer).toBe("Authorization: Bearer [redacted]");

    const labelQuotedSecret = 'fixture: "opaque-123"';
    expect(
      keptToolResult(
        {
          ...base,
          result: { content: [{ type: "text", text: `Rejected value ${labelQuotedSecret}` }] },
        },
        [labelQuotedSecret],
      ),
    ).toBe("Rejected value [redacted]");

    expect(
      keptToolResult(
        {
          ...base,
          result: {
            content: [{ type: "text", text: '"s\\u00e9cret-123"\n"done"\n"s\\u00e9cret-123"' }],
          },
        },
        ["sécret-123"],
      ),
    ).toBe('"[redacted]"\n"done"\n"[redacted]"');

    expect(
      keptToolResult(
        {
          ...base,
          result: {
            content: [{ type: "text", text: 'Response body: "s\\u00e9cret-123" (HTTP 400)' }],
          },
        },
        ["sécret-123"],
      ),
    ).toBe('Response body: "[redacted]" (HTTP 400)');

    expect(
      keptToolResult({ ...base, error: new Error('Authorization: Bearer\n "opaque-123"') }, []),
    ).toBe("Authorization: Bearer [redacted]");

    expect(
      keptToolResult(
        {
          ...base,
          result: { content: [{ type: "text", text: 'Authorization: Bearer\n "opaque-123"' }] },
        },
        [],
      ),
    ).toBe("Authorization: Bearer [redacted]");

    const jsonObjSecret = '{"mode":"opaque-123"}';
    expect(
      JSON.parse(
        keptToolResult(
          {
            ...base,
            result: {
              content: [{ type: "text", text: '{"value":{"mode":"opaque-123"},"next":"ok"}' }],
            },
          },
          [jsonObjSecret],
        )!,
      ),
    ).toEqual({ value: "[redacted]", next: "ok" });

    const escapedKept = keptToolResult(
      {
        ...base,
        result: {
          content: [
            { type: "text", text: '{"message":"details: [\\"opaque-123\\"]","next":"ok"}' },
          ],
        },
      },
      ['\\"opaque-123\\"'],
    )!;
    expect(escapedKept).not.toContain('\\"opaque-123\\"');
    expect(JSON.parse(escapedKept)).toEqual({ message: "details: [[redacted]]", next: "ok" });
  });

  it("replays tool calls only to runs the owner started themselves, failing closed", () => {
    const owner = { fromUser: true, nonOwnerChat: false };
    // Every trigger, so a new one must be decided here; any not allowed gets plain step labels.
    const expected: Record<RunTrigger, boolean> = {
      user: true,
      call_end: true,
      follow_up: true,
      messaging: true,
      routine: false,
      resume: false,
      reaction: false,
      spawn: false,
      skill: false,
      bot_message: false,
      webhook: false,
      cloud_agent: false,
      purchase: false,
      media: false,
      created: false,
      tickets: false,
      helper: false,
      helper_result: false,
    };
    expect(Object.keys(expected).sort()).toEqual([...RUN_TRIGGERS].sort());
    for (const trigger of RUN_TRIGGERS)
      expect([trigger, runReplaysToolHistory(trigger, owner)]).toEqual([
        trigger,
        expected[trigger],
      ]);
    expect(runReplaysToolHistory("a-trigger-added-later", owner)).toBe(false);
    // Answering a paused run's question requeues that same run with its original trigger and
    // source, so a resume gets the original's decision; "resume" alone traces to no original.
    expect(runReplaysToolHistory("user", owner)).toBe(true);
    expect(runReplaysToolHistory("bot_message", owner)).toBe(false);
    expect(runReplaysToolHistory("resume", owner)).toBe(false);
    // A follow-up the bot queued, a channel, or another person in a team chat never gets them.
    expect(runReplaysToolHistory("follow_up", { fromUser: false, nonOwnerChat: false })).toBe(
      false,
    );
    for (const trigger of ["messaging", "user"])
      expect(runReplaysToolHistory(trigger, { fromUser: true, nonOwnerChat: true })).toBe(false);
  });

  it("holds a result that arrives before its call is kept, for the call's handler", () => {
    const reply = { toolStepCalls: new Map(), keptResultChars: 0 } as unknown as ReplyState;
    const done = { ...base, result: { content: [{ type: "text", text: "fast" }] } };
    keepToolStepResult(reply, done, []);
    expect(reply.toolStepCalls.size).toBe(0);
    expect(reply.earlyCompletions?.get("call-1")).toBe(done);
  });

  it("marks a call that exited non-zero as failed, like its step's outcome", () => {
    const reply = {
      toolStepCalls: new Map([["call-1", { arguments: "{}" }]]),
      keptResultChars: 0,
    } as unknown as ReplyState;
    keepToolStepResult(
      reply,
      {
        ...base,
        result: { content: [{ type: "text", text: "no such file" }], details: { exitCode: 2 } },
      },
      [],
    );
    expect(reply.toolStepCalls.get("call-1")).toMatchObject({ failed: true });
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
    // A saved page read back holds what an earlier run copied in, so any kept result counts.
    expect(
      historyReplaysOutsideContent(
        reply("save_page", { arguments: '{"pageId":"p1"}', result: "<page source>" }),
      ),
    ).toBe(true);
    // A call with nothing kept adds no outside text.
    expect(historyReplaysOutsideContent(reply("web_fetch", { arguments: "{}" }))).toBe(false);
    expect(historyReplaysOutsideContent([{ role: "user", content: "Hi" }])).toBe(false);
  });

  it("saves the reply's last screenshot as a hidden artifact and points its call at it", async () => {
    const reply = {
      toolStepCalls: new Map([
        ["call-1", { arguments: "{}" }],
        ["call-2", { arguments: "{}" }],
      ]),
      keptResultChars: 0,
    } as unknown as ReplyState;
    const shot = (byte: number) => ({
      content: [
        { type: "text", text: "computer observed" },
        { type: "image", data: Buffer.from([byte]).toString("base64"), mimeType: "image/png" },
      ],
    });
    keepToolStepResult(reply, { ...base, name: "computer_observe", result: shot(1) }, []);
    keepToolStepResult(
      reply,
      { ...base, name: "computer_observe", executionId: "call-2", result: shot(2) },
      [],
    );
    // A picture the bot read or fetched is neither kept nor replaces the screenshot.
    for (const name of ["read_file", "web_fetch"]) {
      keepToolStepResult(reply, { ...base, name, executionId: "call-1", result: shot(3) }, []);
    }
    // Only the latest screenshot of the reply is kept.
    expect(reply.latestScreenshot).toMatchObject({ executionId: "call-2", mimeType: "image/png" });
    const create = vi.fn(async ({ data }: { data: { mimeType: string } }) => ({
      id: "shot-1",
      ...data,
    }));
    const put = vi.fn(async () => ({ id: "storage-1" }));
    const ctx = {
      deps: {
        prisma: { artifact: { findFirst: vi.fn(async () => null), create } },
        artifacts: { put, remove: vi.fn() },
      },
      run: { spaceId: "space-1", userId: "user-1" },
      bot: { id: "bot-1" },
      thread: { groupId: null },
      runId: "run-1",
      state: { reply },
    } as unknown as RunContext;
    await saveLatestStepScreenshot(ctx);
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: "image/png;profile=step-screenshot",
        bytes: new Uint8Array([2]),
      }),
      expect.anything(),
    );
    expect(create.mock.calls[0]![0].data).toMatchObject({
      spaceId: "space-1",
      botId: "bot-1",
      runId: "run-1",
      mimeType: "image/png;profile=step-screenshot",
    });
    expect(reply.toolStepCalls.get("call-2")).toMatchObject({ image: { artifactId: "shot-1" } });
    expect(reply.toolStepCalls.get("call-1")?.image).toBeUndefined();
    expect(reply.latestScreenshot).toBeUndefined();
  });

  it("redacts JSON credential fields in linear time without skipping subsequent lines", () => {
    const withCreds = keptToolResult(
      {
        ...base,
        result: {
          content: [
            {
              type: "text",
              text: [
                'note "unpaired',
                '{"api_key":"fake-key-1","my-token": "fake-tok-2","ok":"keep"}',
                '{"token":"malformed-trailing-backslash\\',
                '{"password":"fake-next-line-pass"}',
                '{"token":"unclosed-quote-before-newline',
                '{"secret":"fake-after-unclosed"}',
                '{"api_key":"multiline-secret-line-1',
                "multiline-secret-continuation-line-2",
                'multiline-secret-line-3"}',
                '{"token":"unterminated-multiline-1',
                "unterminated-multiline-continuation-2",
                '  "password": "next-field-after-multiline"}',
                '{"token":"unterminated-before-empty-key',
                '  "": "keep-empty-key-value", "secret": "after-empty-key"}',
                '{"token":"unterminated-before-escaped-key',
                '  "a\\"b": "keep-escaped-key-value", "api_key": "after-escaped-key"}',
                '{"token":"unterminated-before-next-line-colon',
                '  "password"',
                '  : "next-line-colon-pass"}',
                '{"api_key":"unclosed-eof-line-1',
                "unclosed-eof-continuation-2",
              ].join("\n"),
            },
          ],
        },
      },
      [],
    );
    expect(withCreds).toContain('"api_key":"[redacted]"');
    expect(withCreds).toContain('"my-token": "[redacted]"');
    expect(withCreds).toContain('"ok":"keep"');
    expect(withCreds).not.toContain("malformed-trailing-backslash");
    expect(withCreds).toContain('"password":"[redacted]"');
    expect(withCreds).not.toContain("fake-next-line-pass");
    expect(withCreds).not.toContain("unclosed-quote-before-newline");
    expect(withCreds).toContain('"secret":"[redacted]"');
    expect(withCreds).not.toContain("fake-after-unclosed");
    expect(withCreds).not.toContain("multiline-secret-line-1");
    expect(withCreds).not.toContain("multiline-secret-continuation-line-2");
    expect(withCreds).not.toContain("multiline-secret-line-3");
    expect(withCreds).not.toContain("unterminated-multiline-1");
    expect(withCreds).not.toContain("unterminated-multiline-continuation-2");
    expect(withCreds).toContain('"password": "[redacted]"');
    expect(withCreds).not.toContain("next-field-after-multiline");
    expect(withCreds).not.toContain("unterminated-before-empty-key");
    expect(withCreds).toContain('"": "keep-empty-key-value"');
    expect(withCreds).toContain('"secret": "[redacted]"');
    expect(withCreds).not.toContain("after-empty-key");
    expect(withCreds).not.toContain("unterminated-before-escaped-key");
    expect(withCreds).toContain('"a\\"b": "keep-escaped-key-value"');
    expect(withCreds).toContain('"api_key": "[redacted]"');
    expect(withCreds).not.toContain("after-escaped-key");
    expect(withCreds).not.toContain("unterminated-before-next-line-colon");
    expect(withCreds).toContain('"password"\n  : "[redacted]"');
    expect(withCreds).not.toContain("next-line-colon-pass");
    expect(withCreds).not.toContain("unclosed-eof-line-1");
    expect(withCreds).not.toContain("unclosed-eof-continuation-2");

    const marker = "\n… [8 characters not kept] …\n";
    const shared = `${marker.slice(0, -1)}${marker}`.repeat(2_000);
    const escapedKey = `{"token":"[r${marker}${"x".repeat(20_000)}", "status\\u0020message": "Job completed"}`;
    expectLinearTime(() => {
      bounded(shared, TOOL_CALL_SAVED_TEXT_MAX_CHARS, [], { replaySaved: true });
      bounded(escapedKey, TOOL_CALL_SAVED_TEXT_MAX_CHARS, [], { replaySaved: true });
    });
    const replayed = bounded(escapedKey, TOOL_CALL_SAVED_TEXT_MAX_CHARS, [], { replaySaved: true });
    expect(replayed).not.toContain("x".repeat(20));
    expect(replayed).toContain("Job completed");
    expect(replayed).toContain('"status\\u0020message": "Job completed"');

    const pathological = `"${"token_".repeat(12_000)}tail`;
    const repeated = '"token":'.repeat(10_000);
    const malformedMultiline = '{"token":"bad\\\n'.repeat(5_000);
    expectLinearTime(() => {
      keptToolResult({ ...base, result: { content: [{ type: "text", text: pathological }] } }, []);
      keptToolResult({ ...base, result: { content: [{ type: "text", text: repeated }] } }, []);
      keptToolResult(
        { ...base, result: { content: [{ type: "text", text: malformedMultiline }] } },
        [],
      );
    });
  });

  it("redacts a quoted COMPOSIO_API_KEY without breaking the JSON around it", () => {
    const secret = "ak_live123";
    const kept = (text: string) =>
      keptToolResult({ ...base, result: { content: [{ type: "text", text }] } }, []);
    expect(kept(`COMPOSIO_API_KEY: "${secret}"`)).not.toContain(secret);
    expect(kept(`COMPOSIO_API_KEY="${secret}"`)).not.toContain(secret);
    expect(kept(`COMPOSIO_API_KEY: '${secret}'`)).not.toContain(secret);
    const json = kept(`{"COMPOSIO_API_KEY": "${secret}", "status": "ok"}`);
    expect(json).not.toContain(secret);
    expect(JSON.parse(json ?? "")).toEqual({ COMPOSIO_API_KEY: "[redacted]", status: "ok" });
    expect(
      bounded(`COMPOSIO_API_KEY: "${secret}"`, 1_000, [], { replaySaved: true }),
    ).not.toContain(secret);
    expect(sanitizeSensitiveText(`COMPOSIO_API_KEY: "${secret}"`)).not.toContain(secret);
    expect(kept(`note COMPOSIO_API_KEY: "${secret}" tail`)).not.toContain(secret);
    expect(
      keptToolResult({ ...base, result: { content: [{ type: "text", text: "Bearer abc]" }] } }, []),
    ).toBe("Bearer [redacted]]");
    expect(
      keptToolResult(
        { ...base, result: { content: [{ type: "text", text: "Bearer abc: detail" }] } },
        [],
      ),
    ).toBe("Bearer [redacted]: detail");
  });

  it("keeps a bearer suffix and a composio assignment inside the redaction", () => {
    const prefix = "fixturePrefix";
    const bearer = `Bearer ${prefix}FixtureTail`;
    expect(
      keptToolResult({ ...base, result: { content: [{ type: "text", text: bearer }] } }, [prefix]),
    ).toBe("Bearer [redacted]");
    expect(sanitizeConnectorError(new Error(bearer), [prefix])).toBe("Bearer [redacted]");
    expect(sanitizeSensitiveText("Bearer [redacted]extra")).toBe("Bearer [redacted]");
    expect(sanitizeSensitiveText("Bearer [redacted]")).toBe("Bearer [redacted]");

    const kept = (text: string, secrets: string[] = []) =>
      keptToolResult({ ...base, result: { content: [{ type: "text", text }] } }, secrets);
    const replay = (text: string, secrets: string[] = []) =>
      bounded(text, 1_000, secrets, { replaySaved: true });
    for (const read of [kept, replay]) {
      expect(read('COMPOSIO_API_KEY : "demo123"')).not.toContain("demo123");
      expect(read('COMPOSIO_API_KEY:\n"demo123"')).not.toContain("demo123");
      expect(read('COMPOSIO_API_KEY: "demo123')).not.toContain("demo123");
      const inside = read('{"message":"COMPOSIO_API_KEY: demo123","status":"ok"}');
      expect(inside).not.toContain("demo123");
      expect(JSON.parse(inside ?? "")).toEqual({
        message: "COMPOSIO_API_KEY=[redacted]",
        status: "ok",
      });
      const escaped = read('{"message":"COMPOSIO_API_KEY: \\"demo123\\"","status":"ok"}');
      expect(escaped).not.toContain("demo123");
      expect(JSON.parse(escaped ?? "")).toEqual({
        message: "COMPOSIO_API_KEY=[redacted]",
        status: "ok",
      });
      const registered = "OTHER_TOKEN=demo-other COMPOSIO_API_KEY=demo-composio";
      expect(read(registered, [registered])).toBe("[redacted]");
    }
    const many = 'COMPOSIO_API_KEY : "demo123" COMPOSIO_API_KEY:\n"demo123" '.repeat(2_000);
    expectLinearTime(() => {
      const redacted = kept(many);
      expect(redacted).not.toContain("demo123");
    });
  });

  it("keeps JSON Lines and log text valid when a composio assignment sits in a string", () => {
    const kept = (text: string, secrets: string[] = []) =>
      keptToolResult({ ...base, result: { content: [{ type: "text", text }] } }, secrets);
    const replay = (text: string, secrets: string[] = []) =>
      bounded(text, 1_000, secrets, { replaySaved: true });
    const messageJsonl = '{"message":"COMPOSIO_API_KEY: demo123","status":"ok"}\n{"status":"done"}';
    const messageLog = 'INFO {"message":"COMPOSIO_API_KEY: demo123","status":"ok"}';
    const escapedJsonl =
      '{"message":"COMPOSIO_API_KEY: \\"ak_live123\\"","status":"ok"}\n{"status":"done"}';
    const escapedLog = 'INFO {"message":"COMPOSIO_API_KEY: \\"ak_live123\\"","status":"ok"}';
    const keyJsonl = '{"COMPOSIO_API_KEY": "ak_live123", "status": "ok"}\n{"status": "done"}';
    const keyLog = 'INFO {"COMPOSIO_API_KEY": "ak_live123", "status": "ok"}';

    for (const read of [kept, replay]) {
      const lines = read(messageJsonl)?.split("\n") ?? [];
      expect(lines[0]).not.toContain("demo123");
      expect(JSON.parse(lines[0] ?? "")).toEqual({
        message: "COMPOSIO_API_KEY=[redacted]",
        status: "ok",
      });
      expect(JSON.parse(lines[1] ?? "")).toEqual({ status: "done" });

      const logged = read(messageLog) ?? "";
      expect(logged.startsWith("INFO ")).toBe(true);
      expect(JSON.parse(logged.slice("INFO ".length))).toEqual({
        message: "COMPOSIO_API_KEY=[redacted]",
        status: "ok",
      });

      const escapedLines = read(escapedJsonl)?.split("\n") ?? [];
      expect(escapedLines[0]).not.toContain("ak_live123");
      expect(JSON.parse(escapedLines[0] ?? "")).toEqual({
        message: "COMPOSIO_API_KEY=[redacted]",
        status: "ok",
      });
      expect(JSON.parse(escapedLines[1] ?? "")).toEqual({ status: "done" });

      const escapedLogged = read(escapedLog) ?? "";
      expect(escapedLogged.startsWith("INFO ")).toBe(true);
      expect(escapedLogged).not.toContain("ak_live123");
      expect(JSON.parse(escapedLogged.slice("INFO ".length))).toEqual({
        message: "COMPOSIO_API_KEY=[redacted]",
        status: "ok",
      });

      const keyLines = read(keyJsonl)?.split("\n") ?? [];
      expect(keyLines[0]).not.toContain("ak_live123");
      expect(JSON.parse(keyLines[0] ?? "")).toEqual({
        COMPOSIO_API_KEY: "[redacted]",
        status: "ok",
      });
      expect(JSON.parse(keyLines[1] ?? "")).toEqual({ status: "done" });

      const keyLogged = read(keyLog) ?? "";
      expect(keyLogged).not.toContain("ak_live123");
      expect(JSON.parse(keyLogged.slice("INFO ".length))).toEqual({
        COMPOSIO_API_KEY: "[redacted]",
        status: "ok",
      });

      expect(read('{"COMPOSIO_API_KEY": "ak_live123')).not.toContain("ak_live123");
    }

    const prefix = "fixturePrefix";
    const bearer = `Bearer ${prefix}\\fixtureTail`;
    expect(kept(bearer, [prefix])).toBe("Bearer [redacted]");
    expect(replay(bearer, [prefix])).toBe("Bearer [redacted]");
    const bearerJson = JSON.stringify({ msg: bearer });
    expect(JSON.parse(kept(bearerJson, [prefix]) ?? "")).toEqual({ msg: "Bearer [redacted]" });
    expect(JSON.parse(replay(bearerJson, [prefix]) ?? "")).toEqual({ msg: "Bearer [redacted]" });

    const many = `${messageJsonl}\n`.repeat(2_000);
    expectLinearTime(() => {
      const redacted = kept(many);
      expect(redacted).not.toContain("demo123");
      expect(redacted).toContain('"status":"ok"');
    });
  });

  it("keeps a log prefix and an escaped credential key around the redaction", () => {
    const kept = (text: string, secrets: string[] = []) =>
      keptToolResult({ ...base, result: { content: [{ type: "text", text }] } }, secrets);
    const replay = (text: string, secrets: string[] = []) =>
      bounded(text, 1_000, secrets, { replaySaved: true });
    const prefixed =
      'INFO label=\\"fixture\\" {"message":"COMPOSIO_API_KEY: fixtureValue123","status":"ok"}';
    const escapedKey = '{"\\u0043OMPOSIO_API_KEY":"fixtureValue123","status":"ok"}';
    for (const read of [kept, replay]) {
      const logged = read(prefixed) ?? "";
      expect(logged.startsWith('INFO label=\\"fixture\\" ')).toBe(true);
      expect(logged).not.toContain("fixtureValue123");
      const brace = logged.indexOf("{");
      expect(JSON.parse(logged.slice(brace))).toEqual({
        message: "COMPOSIO_API_KEY=[redacted]",
        status: "ok",
      });
      const decoded = read(escapedKey) ?? "";
      expect(decoded).not.toContain("fixtureValue123");
      expect(JSON.parse(decoded)).toEqual({
        COMPOSIO_API_KEY: "[redacted]",
        status: "ok",
      });
    }
  });

  it("redacts a decoded bearer suffix and a credential after a quoted log prefix", () => {
    const kept = (text: string, secrets: string[] = []) =>
      keptToolResult({ ...base, result: { content: [{ type: "text", text }] } }, secrets);
    const replay = (text: string, secrets: string[] = []) =>
      bounded(text, 1_000, secrets, { replaySaved: true });
    const bearerTails = [
      "Bearer fixturePrefix\\nameTail",
      "Bearer fixturePrefix\\rTail",
      "Bearer fixturePrefix\\tTail",
      "Bearer fixturePrefix\\\\Tail",
    ];
    const prefixes = ['INFO path="C:\\logs\\latest"', "INFO label='mix\"ed'"];
    for (const read of [kept, replay]) {
      for (const tail of bearerTails) {
        const raw = JSON.stringify({ message: tail, status: "ok" });
        expect(JSON.parse(read(raw) ?? "")).toEqual({ message: "Bearer [redacted]", status: "ok" });
      }
      const keptSlash = JSON.stringify({ message: "Bearer [redacted]\\", status: "ok" });
      expect(JSON.parse(read(keptSlash) ?? "")).toEqual({
        message: "Bearer [redacted]",
        status: "ok",
      });
      const keptLine = JSON.stringify({ message: "Bearer [redacted]\nNext line", status: "ok" });
      expect(JSON.parse(read(keptLine) ?? "")).toEqual({
        message: "Bearer [redacted]\nNext line",
        status: "ok",
      });
      for (const prefix of prefixes) {
        for (const key of ["access_token", "COMPOSIO_API_KEY"]) {
          const raw = `${prefix} {"${key}":"fixtureValue123","status":"ok"}`;
          const logged = read(raw) ?? "";
          expect(logged.startsWith(`${prefix} `)).toBe(true);
          expect(logged).not.toContain("fixtureValue123");
          expect(JSON.parse(logged.slice(logged.indexOf("{")))).toEqual({
            [key]: "[redacted]",
            status: "ok",
          });
        }
      }
    }
    const wide =
      'INFO path="C:\\logs\\latest" {"access_token":"fixtureValue123","status":"ok"}\n'.repeat(
        40_000,
      );
    expect(wide.length).toBeGreaterThan(2_000_000);
    expectLinearTime(() => {
      const redacted = kept(wide) ?? "";
      expect(redacted).not.toContain("fixtureValue123");
      expect(redacted).toContain('"status":"ok"');
    });
  });

  it("redacts a raw credential that contains a forged omission marker, including its suffix", () => {
    const forged = "\n… [12 characters not kept] …\n";
    const suffix = "SECRET_SUFFIX_UNLABELED";
    const forgedCredential = (value: string) =>
      keptToolResult(
        {
          ...base,
          result: {
            content: [{ type: "text", text: `{"token":"${value}","after":"END_OF_TAIL"}` }],
          },
        },
        [],
      );
    for (const value of [`prefix${forged}${suffix}`, `prefix\\${forged}${suffix}`]) {
      const kept = forgedCredential(value);
      expect(kept).toContain('"after":"END_OF_TAIL"');
      expect(kept).toContain('"token":"[redacted]"');
      expect(kept).not.toContain(suffix);
      expect(kept).not.toContain("prefix");
      expect(kept).not.toContain("characters not kept");
    }
  });

  it("redacts Unicode-escaped JSON secrets under ordinary fields and across error truncation cuts", () => {
    const secret = "secret-value-99";
    const escaped = "\\u0073\\u0065cret-value-99";
    const kept = keptToolResult(
      {
        ...base,
        result: {
          content: [{ type: "text", text: `{"note":"prefix ${escaped} suffix"}` }],
        },
      },
      [secret],
    );
    expect(kept).toBe('{"note":"prefix [redacted] suffix"}');

    const pad = "e".repeat(1_990);
    const errorKept = keptToolResult(
      {
        ...base,
        error: new Error(`{"note":"${pad}${escaped} trailing"}`),
      },
      [secret],
      2_500,
    );
    expect(errorKept).toBeDefined();
    expect(errorKept).not.toContain("secret");
    expect(errorKept).not.toContain("\\u0073");
    expect(errorKept).not.toContain("value-99");
    expect(errorKept).toContain("[redacted]");
  });

  it("keeps both bounded truncation edges well-formed UTF-16 across surrogate pairs", () => {
    const pair = "😀";
    // Length 110 with surrogate pairs straddling both head (70% of 40 = 28) and tail (12) cuts.
    const text = `a${pair.repeat(14)}${"m".repeat(52)}${pair.repeat(7)}z`;
    const cut = keptToolResult({ ...base, result: { content: [{ type: "text", text }] } }, [], 40);
    expect(cut).toBeDefined();
    expect(Buffer.from(cut!, "utf8").toString("utf8")).toBe(cut);
    expect(cut).toContain("characters not kept");
  });

  it("redacts whole JSON arrays, JSONL objects, escaped quotes, punctuated diagnostics, and preserves Bearer JSON keys", () => {
    const arrayKept = keptToolResult(
      {
        ...base,
        result: { content: [{ type: "text", text: '{"value":[731428,918273],"next":"ok"}' }] },
      },
      ["[731428,918273]"],
    );
    expect(JSON.parse(arrayKept ?? "")).toEqual({ value: "[redacted]", next: "ok" });

    const escapedKept = keptToolResult(
      {
        ...base,
        result: {
          content: [
            { type: "text", text: '{"message":"details: [\\"opaque-123\\"]","next":"ok"}' },
          ],
        },
      },
      ['\\"opaque-123\\"'],
    );
    expect(escapedKept).not.toContain('\\"opaque-123\\"');
    expect(JSON.parse(escapedKept ?? "")).toEqual({ message: "details: [[redacted]]", next: "ok" });

    const jsonlKept = keptToolResult(
      {
        ...base,
        result: {
          content: [
            { type: "text", text: '{"value":{"mode":"opaque-123"},"next":"ok"}\n{"done":true}' },
          ],
        },
      },
      ['{"mode":"opaque-123"}'],
    );
    expect((jsonlKept ?? "").split("\n").map((line) => JSON.parse(line))).toEqual([
      { value: "[redacted]", next: "ok" },
      { done: true },
    ]);

    const punctuatedKept = keptToolResult(
      {
        ...base,
        result: {
          content: [{ type: "text", text: 'Response body: "s\\u00e9cret-123". HTTP 400' }],
        },
      },
      ["sécret-123"],
    );
    expect(punctuatedKept).toBe('Response body: "[redacted]". HTTP 400');

    const bearerKeyKept = keptToolResult(
      {
        ...base,
        result: { content: [{ type: "text", text: '{"Bearer ":"next"}' }] },
      },
      [],
    );
    expect(JSON.parse(bearerKeyKept ?? "")).toEqual({ "Bearer ": "next" });
    expect(sanitizeSensitiveText('{"Bearer ":"next"}')).toBe('{"Bearer ":"next"}');
    expect(
      JSON.parse(sanitizeSensitiveText(JSON.stringify({ message: 'Bearer "opaque-123"' }))),
    ).toEqual({ message: "Bearer [redacted]" });

    const clippedEscaped = keptToolResult(
      {
        ...base,
        result: { content: [{ type: "text", text: '{"message":"details: [\\"opaque-123\\"]' }] },
      },
      ['\\"opaque-123\\"'],
    );
    expect(clippedEscaped).toBe('{"message":"details: [[redacted]]');

    const rawAndDecoded = keptToolResult(
      {
        ...base,
        result: {
          content: [{ type: "text", text: '{"message":"\\u006fpaque-123 and other-secret"}' }],
        },
      },
      ["\\u006fpaque-123", "other-secret"],
    );
    expect(JSON.parse(rawAndDecoded ?? "")).toEqual({ message: "[redacted] and [redacted]" });

    const multilineLine = keptToolResult(
      {
        ...base,
        result: { content: [{ type: "text", text: '{"message":"opaque-1234567890"}' }] },
      },
      ['heading\n"opaque-1234567890"\nfooter'],
    );
    expect(JSON.parse(multilineLine ?? "")).toEqual({ message: "[redacted]" });

    const primitiveJsonl = keptToolResult(
      {
        ...base,
        result: { content: [{ type: "text", text: '{"done":true}\n731428' }] },
      },
      ["731428"],
    );
    expect((primitiveJsonl ?? "").split("\n").map((line) => JSON.parse(line))).toEqual([
      { done: true },
      "[redacted]",
    ]);

    const storedTranscript = JSON.stringify({
      version: 1,
      represents: ["ask"],
      messages: [
        {
          role: "user",
          content:
            'Replying to:\n<reply_target>{"message":"details: [\\"opaque-123\\"]","next":"ok"}</reply_target>',
          timestamp: 0,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          stopReason: "stop",
          timestamp: 0,
        },
      ],
    });
    const cleanedTranscript = keptTurnTranscript(storedTranscript, ['\\"opaque-123\\"']);
    expect(cleanedTranscript).toBeDefined();
    expect(cleanedTranscript).not.toContain('\\"opaque-123\\"');
    const parsedTranscript = JSON.parse(cleanedTranscript!) as {
      messages: Array<{ content: string }>;
    };
    const innerJson = parsedTranscript.messages[0]?.content.match(
      /<reply_target>([\s\S]*?)<\/reply_target>/,
    )?.[1];
    expect(JSON.parse(innerJson ?? "")).toEqual({ message: "details: [[redacted]]", next: "ok" });
  });
});
