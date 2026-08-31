import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { abortableDelay, inferHandoffTargetName } from "@rakazo/core";

const running = new Map<string, AbortController>();

export class ScriptedAgentRuntime implements AgentRuntime {
  describe() {
    return {
      id: "scripted",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: true },
    };
  }

  async abort(runId: string): Promise<void> {
    running.get(runId)?.abort();
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const controller = new AbortController();
    running.set(request.runId, controller);
    const signal = context?.signal ?? controller.signal;
    try {
      if (shouldFail(request.prompt)) {
        throw new Error("Scripted run failure");
      }
      if (shouldHang(request.prompt)) {
        yield { type: "progress", text: "still working…" };
        while (!controller.signal.aborted && !signal.aborted) {
          await abortableDelay(50, controller.signal);
          if (controller.signal.aborted || signal.aborted) break;
          yield { type: "progress", text: "still working…" };
        }
        yield { type: "done", text: "stopped" };
        return;
      }
      const script = request.script ?? inferScript(request.prompt, request.resumeFromCheckpoint);
      // Per-run call index so repeated tools (e.g. message_agent) get distinct
      // executionIds — delivery keys and effect replays key off this value.
      let toolCallSeq = 0;
      for (const turn of script) {
        if (signal.aborted || controller.signal.aborted) {
          yield { type: "done", text: "stopped" };
          return;
        }
        if (turn.assistant) {
          yield { type: "progress", text: "working…" };
          yield { type: "text", text: turn.assistant };
        }
        for (const call of turn.toolCalls ?? []) {
          const executionId = `${request.runId}:${call.name}:${toolCallSeq++}`;
          if (call.name === "run_subagent") {
            const agentId = `${request.runId}:subagent`;
            const name = String(call.args.name ?? "helper");
            const task = String(call.args.task ?? request.prompt);
            yield {
              type: "subagent",
              agentId,
              name,
              task,
              status: "running",
              progress: "working…",
            };
            yield {
              type: "tool",
              name: call.name,
              args: call.args,
              executionId,
            };
            yield {
              type: "subagent",
              agentId,
              name,
              task,
              status: "completed",
              result: `done. i handled: ${task.slice(0, 180)}`,
            };
            continue;
          }
          yield {
            type: "tool",
            name: call.name,
            args: call.args,
            executionId,
          };
        }
        if (turn.ask) {
          yield { type: "ask", text: turn.ask.text, detail: turn.ask.detail };
          return;
        }
        if (turn.takeover) {
          yield { type: "takeover", reason: turn.takeover.reason };
          return;
        }
        if (turn.complete) {
          yield {
            type: "usage",
            inputTokens: 12,
            outputTokens: 40,
            provider: "scripted",
            model: "scripted",
          };
          yield { type: "done", text: turn.assistant };
          return;
        }
      }
      yield { type: "text", text: "done." };
      yield { type: "done", text: "done." };
    } finally {
      controller.abort();
      running.delete(request.runId);
    }
  }
}

export function inferScript(
  prompt: string,
  resumeFromCheckpoint?: string,
): NonNullable<AgentRunRequest["script"]> {
  const lower = prompt.toLowerCase();
  if (resumeFromCheckpoint === "takeover-skipped") {
    return [
      {
        assistant: "login was skipped. continuing without treating sign-in as done.",
        complete: true,
      },
    ];
  }
  if (resumeFromCheckpoint === "takeover") {
    return [
      {
        assistant:
          "signed in. the session stays in this computer — protected input never hit the thread.",
        complete: true,
      },
    ];
  }
  // Before every content-based intent so payload text cannot steal the branch.
  if (lower.includes("message the bot named") || lower.includes("message bot named")) {
    const name = namedBot(prompt) ?? "Peer";
    const message =
      /named\s+[A-Za-z0-9][A-Za-z0-9_-]{0,39}\s+(?:saying|with|:)\s*([\s\S]+)$/i
        .exec(prompt)?.[1]
        ?.trim() ?? `Please help with: ${prompt}`;
    return [
      {
        assistant: "messaging that bot now.",
        toolCalls: [
          {
            name: "message_bot",
            args: {
              confirm_name: name,
              message,
              intent: "request",
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("ask me") ||
    lower.includes("which city") ||
    lower.includes("need a decision")
  ) {
    return [
      {
        assistant: "i need a decision before i continue.",
        ask: { text: "Which city should I use?", detail: "Reply with one city name." },
      },
    ];
  }
  if (lower.includes("take over") || lower.includes("sign in") || lower.includes("login")) {
    return [
      { assistant: "i need you on the screen for a one-time sign-in. handing you the computer." },
      { takeover: { reason: "Sign in to continue. Protected input stays off the thread." } },
    ];
  }
  if (
    lower.includes("observe your screen") ||
    lower.includes("look at your screen") ||
    lower.includes("use your screen")
  ) {
    const typed = /type\s+([A-Za-z0-9._-]+)/i.exec(prompt)?.[1] ?? "ready";
    return [
      {
        assistant: "using my screen now.",
        toolCalls: [
          { name: "computer_observe", args: {} },
          {
            name: "computer_act",
            args: {
              actions: [{ kind: "type", text: typed }],
              observe: true,
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("delete the bot named") ||
    lower.includes("delete the child bot") ||
    lower.includes("delete child")
  ) {
    const name = namedBot(prompt) ?? "Scout";
    return [
      {
        assistant: "archiving that bot.",
        toolCalls: [{ name: "archive_bot", args: { confirm_name: name } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("create a space") ||
    lower.includes("create space") ||
    lower.includes("new space named") ||
    lower.includes("new private space")
  ) {
    const name = namedSpace(prompt) ?? "New space";
    return [
      {
        assistant: "i can create that separate space after you confirm the boundary.",
        toolCalls: [{ name: "create_space", args: { name } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("spawn a bot") ||
    lower.includes("spawn a child") ||
    lower.includes("create a bot named") ||
    lower.includes("create a child bot")
  ) {
    const name = namedBot(prompt) ?? "Helper";
    return [
      {
        assistant: "creating a bot for that.",
        toolCalls: [
          {
            name: "spawn_bot",
            args: {
              name,
              title: `${name} specialist`,
              instructions: `You are ${name}.`,
              prompt: "Start on the assigned work.",
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.includes("subagent") || lower.includes("delegate to a helper")) {
    return [
      {
        assistant: "spinning up a helper for that.",
        toolCalls: [{ name: "run_subagent", args: { name: "helper", task: prompt } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("hand this to") ||
    lower.includes("hand off to") ||
    lower.includes("handoff to") ||
    (lower.includes("@writer") && lower.includes("draft"))
  ) {
    const target = inferHandoffTargetName(prompt) ?? "Writer";
    return [
      {
        assistant: "handing this off in the group thread.",
        toolCalls: [
          {
            name: "handoff_to_bot",
            args: {
              confirm_name: target,
              message: prompt,
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.startsWith("run taught skill:") || lower.includes("this is a safe test")) {
    return [
      {
        assistant:
          "Running the taught skill using its saved playbook. I will follow the demonstrated steps and report the result.",
        complete: true,
      },
    ];
  }
  if (/^run\s+/.test(lower)) {
    return [
      {
        assistant:
          "Using the saved taught skill playbook for that request and following its steps.",
        complete: true,
      },
    ];
  }
  if (lower.includes("connector") || lower.includes("crm") || lower.includes("destination")) {
    return [
      {
        assistant: "writing the record through the connected destination.",
        toolCalls: [
          {
            name: "destination.write",
            args: { collection: "notes", title: "Rakazo result", body: prompt },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.includes("attach") && (lower.includes("thread") || lower.includes("into the thread"))) {
    const said = /says?\s+(.+)$/i.exec(prompt)?.[1]?.replace(/[.]+$/, "") ?? prompt;
    const content = `${said.trim()}\n`;
    const filePath =
      /(?:called|named|path|file)\s+([A-Za-z0-9._/-]+)/i.exec(prompt)?.[1] ?? "notes/result.txt";
    return [
      { assistant: "writing that into my home and attaching it to the thread." },
      { toolCalls: [{ name: "write_file", args: { path: filePath, content } }] },
      { toolCalls: [{ name: "attach_file", args: { path: filePath } }], complete: true },
    ];
  }
  if (
    lower.includes("write") &&
    (lower.includes("file") || lower.includes("home") || lower.includes("note"))
  ) {
    const said = /says?\s+(.+)$/i.exec(prompt)?.[1]?.replace(/[.]+$/, "") ?? prompt;
    const content = `${said.trim()}\n`;
    const filePath =
      /(?:called|named)\s+([A-Za-z0-9._/-]+)/i.exec(prompt)?.[1] ?? "notes/result.txt";
    return [
      { assistant: "writing that into my home now." },
      {
        toolCalls: [{ name: "write_file", args: { path: filePath, content } }],
        complete: true,
      },
    ];
  }
  if (lower.includes("remember")) {
    return [
      {
        assistant: "noted — i will keep that in memory.",
        memory: [{ scope: "bot", path: "MEMORY.md", content: `# Memory\n\n- ${prompt}\n` }],
        complete: true,
      },
    ];
  }
  return [
    {
      assistant: `on it. i will work this in the background and come back with a result.\n\n${summarize(prompt)}`,
    },
    {
      files: [{ path: "notes/last-task.md", content: `# Task\n\n${prompt}\n` }],
      complete: true,
    },
  ];
}

function shouldFail(prompt: string): boolean {
  return prompt.toLowerCase().includes("fail this run");
}

function shouldHang(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    lower.includes("keep working") ||
    lower.includes("work until i stop") ||
    lower.includes("until i stop you") ||
    lower.includes("hang until stopped")
  );
}

function namedBot(prompt: string) {
  return /named\s+([A-Za-z0-9][A-Za-z0-9_-]{0,39})/i.exec(prompt)?.[1];
}

function namedSpace(prompt: string) {
  return /space\s+(?:named|called)\s+["“]?([^"”\n]{1,60})/i
    .exec(prompt)?.[1]
    ?.replace(/[.!?]+$/, "")
    .trim();
}

function summarize(prompt: string): string {
  return `done. i handled: ${prompt.slice(0, 180)}`;
}
