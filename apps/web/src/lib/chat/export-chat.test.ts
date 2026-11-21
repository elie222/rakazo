import type { Bot, Group, ThreadMessage } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import { isConnectionFailure } from "@rakazo/core/user-error";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../query/rpc";

const download = vi.hoisted(() => vi.fn());
vi.mock("../pages/artifact-open", () => ({ downloadArtifactBytes: download }));

import { resolveTranscriptMemberName } from "../../pages/shell/chat/transcript-member-name";
import { ChatTooLongError, chatExportFileName, exportChat } from "./export-chat";

afterEach(() => download.mockReset());

let seq = 0;
function message(
  text: string,
  extra: Partial<ThreadMessage> = {},
  role: ThreadMessage["role"] = "bot",
): ThreadMessage {
  seq += 1;
  return {
    id: `m_${seq}`,
    threadId: "t_1",
    seq,
    role,
    blocks: [{ kind: "text", text }],
    createdAt: `2026-03-04T10:0${seq % 10}:00.000Z`,
    ...extra,
  };
}

const bot = { id: "bot-1", name: "Ada" } as Bot;
const group = {
  id: "group-1",
  name: "Launch crew",
  members: [
    { botId: "bot-1", name: "Ada", color: "ink" },
    { botId: "bot-2", name: "Lee", color: "ink" },
  ],
} as Group;
const labels = {
  you: "You",
  system: "System",
  routineEvent: (change: string, name: string) => `${change} routine "${name}"`,
  attachment: "Attachment",
  bot: "bot",
  ask: {
    answer: "Answer",
    expired: "Expired",
    more: (count: string) => `${count} more`,
    total: "Total",
    onTheButton: "On the button",
    to: "To",
    subject: "Subject",
    updateInstructions: "Update instructions?",
    instructionsUpdated: "Instructions updated",
    settingsUpdated: "Settings updated",
    readFromPage: "Read from the page, not checked",
    buttonReadFromPage: (button: string) => `Button “${button}”. Read from the page, not checked`,
    approved: "Approved",
    discarded: "Discarded",
    commandVariable: "Command variable",
    codeFrom: (host: string) => `Only enter a code ${host} sent you.`,
    answered: "Answered",
    created: "Created",
    cancelled: "Cancelled",
    allowedInSpace: "Allowed in this space",
    allowedOnce: "Allowed once",
    alwaysAllowed: "Always allowed",
    denied: "Denied",
    answeredWith: (answer: string) => `Answered: ${answer}`,
    actionLabel: (action: { label: string }) => action.label,
  },
  status: {
    saved: "Saved",
    sent: "Sent",
    dismissed: "Dismissed",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    stopped: "Stopped",
    archived: "archived",
    deleted: "deleted",
    setupComplete: "Setup complete",
    phoneCall: "Phone call",
    incomingCall: "Incoming call",
    callingYou: "Calling you…",
    missedCall: "Missed call",
    youDeclined: "You declined",
    connected: "Connected",
    declined: "Declined",
    needsYou: "Needs you",
    skipped: "Skipped",
    done: "Done",
    cloudAgent: {
      running: "running",
      finished: "finished",
      failed: "failed",
      cancelled: "cancelled",
      expired: "expired",
    },
  },
  cards: {
    computer: "Computer",
    pullRequest: "Pull request",
    connectMcpServer: (name: string) => `Connect MCP server “${name}”`,
    draftSkill: "Draft skill",
    skillName: "Name",
    whenToUse: "When to use",
    inputs: "Inputs",
    steps: "Steps",
    howToCheck: "How to check",
    whatToReturn: "What to return",
    approvalBoundaries: "Approval boundaries",
    failureHandling: "Failure handling",
    choiceQuestion: (question: string) => question,
    choiceOption: (option: { label: string }) => option.label,
  },
};
const time = (createdAt: string) => createdAt.slice(11, 16);
const noMembers = () => undefined;

type Page = { messages: ThreadMessage[]; olderCursor: number | null };
function rpcWith(pages: Page[]) {
  const messages = vi.fn(async (_input: unknown) => ({ threadId: "t_1", ...pages.shift()! }));
  return { rpc: { threads: { messages } } as unknown as RpcClient, messages };
}

function exported() {
  const [name, mimeType, bytes] = download.mock.calls[0] as [string, string, Uint8Array];
  return { name, mimeType, text: new TextDecoder().decode(bytes) };
}

describe("exportChat", () => {
  const checklist = {
    kind: "import_setup" as const,
    items: [{ kind: "routine" as const, routineId: "r_1", name: "Morning digest" }],
  };

  it("writes a finished checklist as its completion, after checking its bot's setup", async () => {
    const importSetupState = vi.fn(async (_input: unknown) => ({
      providers: {},
      serverIds: {},
      routineIds: { r_1: true },
    }));
    const messages = vi.fn(async (_input: unknown) => ({
      threadId: "t_1",
      // The server writes a checklist without a bot id; the chat's bot is the one checked.
      messages: [message("", { blocks: [checklist] })],
      olderCursor: null,
    }));
    const rpc = { threads: { messages }, bots: { importSetupState } } as unknown as RpcClient;
    await exportChat({
      rpc,
      target: { kind: "bot", chat: bot },
      labels,
      time,
      memberName: noMembers,
    });
    expect(importSetupState.mock.calls[0]?.[0]).toEqual({
      botId: "bot-1",
      providers: [],
      serverIds: [],
      routineIds: ["r_1"],
    });
    expect(exported().text).toContain("Setup complete");
    expect(exported().text).not.toContain("Morning digest");
  });

  it("stops waiting on a setup check that never answers, and keeps the checklist's items", async () => {
    // Node's AbortSignal.timeout ignores fake timers, so the test hands out controllable signals and
    // aborts the setup check's own one, as its deadline would.
    const controllers: { ms: number; controller: AbortController }[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      controllers.push({ ms, controller });
      return controller.signal;
    });
    try {
      // The real client rejects a call whose signal aborts; the mock does the same.
      const importSetupState = vi.fn(
        (_input: unknown, options: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) =>
            options.signal.addEventListener("abort", () => reject(options.signal.reason)),
          ),
      );
      const messages = vi.fn(async (_input: unknown) => ({
        threadId: "t_1",
        messages: [message("", { blocks: [checklist] })],
        olderCursor: null,
      }));
      const rpc = { threads: { messages }, bots: { importSetupState } } as unknown as RpcClient;
      const exporting = exportChat({
        rpc,
        target: { kind: "bot", chat: bot },
        labels,
        time,
        memberName: noMembers,
      });
      await vi.waitFor(() => expect(importSetupState).toHaveBeenCalled());
      const setupDeadline = controllers.find(({ ms }) => ms === 15_000);
      expect(setupDeadline).toBeDefined();
      setupDeadline?.controller.abort(new DOMException("timed out", "TimeoutError"));
      await exporting;
      expect(exported().text).toContain("- Morning digest");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("ends all setup checks at one shared deadline, sending none still waiting", async () => {
    // As above: controllable signals stand in for Node's timeouts, and the shared one is aborted.
    const controllers: { ms: number; controller: AbortController }[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      controllers.push({ ms, controller });
      return controller.signal;
    });
    try {
      const lists = Array.from({ length: 6 }, (_, i) => ({
        kind: "import_setup" as const,
        items: [{ kind: "routine" as const, routineId: `r_${i}`, name: `Routine ${i}` }],
      }));
      const importSetupState = vi.fn(
        (_input: unknown, options: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) =>
            options.signal.addEventListener("abort", () => reject(options.signal.reason)),
          ),
      );
      const messages = vi.fn(async (_input: unknown) => ({
        threadId: "t_1",
        messages: [message("", { blocks: lists })],
        olderCursor: null,
      }));
      const rpc = { threads: { messages }, bots: { importSetupState } } as unknown as RpcClient;
      const exporting = exportChat({
        rpc,
        target: { kind: "bot", chat: bot },
        labels,
        time,
        memberName: noMembers,
      });
      await vi.waitFor(() => expect(importSetupState).toHaveBeenCalledTimes(4));
      const allChecks = controllers.find(({ ms }) => ms === 60_000);
      expect(allChecks).toBeDefined();
      allChecks?.controller.abort(new DOMException("timed out", "TimeoutError"));
      await exporting;
      expect(importSetupState).toHaveBeenCalledTimes(4);
      for (let i = 0; i < 6; i += 1) expect(exported().text).toContain(`- Routine ${i}`);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps a checklist's items when its setup cannot be checked, as its card does", async () => {
    const importSetupState = vi.fn(async (_input: unknown) => {
      throw new Error("offline");
    });
    const messages = vi.fn(async (_input: unknown) => ({
      threadId: "t_1",
      messages: [message("", { botId: "bot-1", blocks: [checklist] })],
      olderCursor: null,
    }));
    const rpc = { threads: { messages }, bots: { importSetupState } } as unknown as RpcClient;
    await exportChat({
      rpc,
      target: { kind: "bot", chat: bot },
      labels,
      time,
      memberName: noMembers,
    });
    expect(exported().text).toContain("- Morning digest");
  });
  it("runs at most four setup checks at once, and checks every checklist", async () => {
    const lists = Array.from({ length: 6 }, (_, i) => ({
      kind: "import_setup" as const,
      items: [{ kind: "routine" as const, routineId: `r_${i}`, name: `Routine ${i}` }],
    }));
    const answers = lists.map(() =>
      deferred<{ providers: object; serverIds: object; routineIds: object }>(),
    );
    let running = 0;
    let most = 0;
    const importSetupState = vi.fn(async (_input: unknown) => {
      running += 1;
      most = Math.max(most, running);
      const index = importSetupState.mock.calls.length - 1;
      try {
        return await answers[index]!.promise;
      } finally {
        running -= 1;
      }
    });
    const messages = vi.fn(async (_input: unknown) => ({
      threadId: "t_1",
      messages: [message("", { blocks: lists })],
      olderCursor: null,
    }));
    const rpc = { threads: { messages }, bots: { importSetupState } } as unknown as RpcClient;
    const exporting = exportChat({
      rpc,
      target: { kind: "bot", chat: bot },
      labels,
      time,
      memberName: noMembers,
    });
    await vi.waitFor(() => expect(importSetupState).toHaveBeenCalledTimes(4));
    await flush();
    expect(importSetupState).toHaveBeenCalledTimes(4);
    for (const [i, answer] of answers.entries()) {
      answer.resolve({ providers: {}, serverIds: {}, routineIds: { [`r_${i}`]: true } });
      await flush();
    }
    await exporting;
    expect(importSetupState).toHaveBeenCalledTimes(6);
    expect(most).toBe(4);
    expect(exported().text).not.toContain("Routine");
  });

  it("names both sides of a handoff in a one-bot chat as the chat row does", async () => {
    const { rpc } = rpcWith([
      {
        messages: [
          message("", {
            blocks: [
              { kind: "handoff", fromBotId: "bot-1", toBotId: "bot-9", text: "Over to you" },
            ],
          }),
        ],
        olderCursor: null,
      },
    ]);
    await exportChat({
      rpc,
      target: { kind: "bot", chat: bot },
      labels,
      time,
      memberName: (botId) =>
        resolveTranscriptMemberName({ botId, members: undefined, bots: [bot], archivedBots: [] }),
    });
    expect(exported().text).toContain("↪ bot ← bot\n\nOver to you");
    expect(exported().text).not.toContain("Deleted bot");
  });

  it("reads every page of history and writes it oldest first", async () => {
    const first = message(
      "Hi",
      { author: { id: "u_1", name: "Dana" }, createdAt: "2026-03-04T01:00:00.000Z" },
      "user",
    );
    const second = message("Hello Dana", { createdAt: "2026-03-04T02:00:00.000Z" });
    const third = message("Summarize my inbox", { createdAt: "2026-03-04T03:00:00.000Z" }, "user");
    const { rpc, messages } = rpcWith([
      { messages: [third], olderCursor: 40 },
      { messages: [second], olderCursor: 20 },
      { messages: [first], olderCursor: null },
    ]);
    await exportChat({
      rpc,
      target: { kind: "bot", chat: bot },
      labels,
      time,
      memberName: noMembers,
      meId: "u_me",
    });

    expect(messages.mock.calls.map(([input]) => input)).toEqual([
      { botId: "bot-1" },
      { botId: "bot-1", before: 40 },
      { botId: "bot-1", before: 20 },
    ]);
    const file = exported();
    expect(file.name).toBe("ada-chat.md");
    expect(file.mimeType).toBe("text/markdown;charset=utf-8");
    expect(file.text.indexOf("Hi")).toBeLessThan(file.text.indexOf("Hello Dana"));
    expect(file.text.indexOf("Hello Dana")).toBeLessThan(file.text.indexOf("Summarize my inbox"));
    expect(file.text).toContain("**Dana** · 01:00\n\nHi");
    expect(file.text).toContain("**You** · 03:00\n\nSummarize my inbox");
    expect(file.text).toContain("**Ada** · 02:00\n\nHello Dana");
  });

  it("names your own messages You, as the chat does", async () => {
    const { rpc } = rpcWith([
      {
        messages: [
          message("Mine", { author: { id: "u_me", name: "Dana" } }, "user"),
          message("Theirs", { author: { id: "u_2", name: "Lee" } }, "user"),
        ],
        olderCursor: null,
      },
    ]);
    await exportChat({
      rpc,
      target: { kind: "bot", chat: bot },
      labels,
      time,
      memberName: noMembers,
      meId: "u_me",
    });
    const { text } = exported();
    expect(text).toMatch(/\*\*You\*\* · \d\d:\d\d\n\nMine/);
    expect(text).toMatch(/\*\*Lee\*\* · \d\d:\d\d\n\nTheirs/);
  });

  it("names each group message for the bot that wrote it", async () => {
    const { rpc, messages } = rpcWith([
      {
        messages: [
          message("From Lee", { botId: "bot-2" }),
          message("From a bot that left", { botId: "bot-7" }),
          message("From an archived bot", { botId: "bot-8" }),
          message("From a removed bot", { botId: "bot-9" }),
          message("Notice", {}, "system"),
        ],
        olderCursor: null,
      },
    ]);
    // The same roster lookup the menu passes: members, then the Space's bots, then archived ones.
    const memberName = (botId: string | undefined) =>
      resolveTranscriptMemberName({
        botId,
        members: group.members,
        bots: [{ id: "bot-7", name: "Moe" }],
        archivedBots: [{ id: "bot-8", name: "Old Ada" }],
      });
    await exportChat({ rpc, target: { kind: "group", chat: group }, labels, time, memberName });
    // The read now also carries the export's deadline signal, which is the change under test.
    expect(messages).toHaveBeenCalledWith(
      { groupId: "group-1" },
      { signal: expect.any(AbortSignal) },
    );
    const { name, text } = exported();
    expect(name).toBe("launch-crew-chat.md");
    expect(text).toMatch(/\*\*Lee\*\* · \d\d:\d\d\n\nFrom Lee/);
    expect(text).toMatch(/\*\*Moe\*\* · \d\d:\d\d\n\nFrom a bot that left/);
    expect(text).toMatch(/\*\*Old Ada\*\* · \d\d:\d\d\n\nFrom an archived bot/);
    expect(text).toMatch(/\*\*Deleted bot\*\* · \d\d:\d\d\n\nFrom a removed bot/);
    expect(text).toMatch(/\*\*System\*\* · \d\d:\d\d\n\nNotice/);
  });

  it("gives up on a page that never answers as a timeout, saving nothing", async () => {
    vi.useFakeTimers();
    try {
      const messages = vi.fn(() => new Promise<never>(() => {}));
      const rpc = { threads: { messages } } as unknown as RpcClient;
      const outcome = exportChat({
        rpc,
        target: { kind: "bot", chat: bot },
        labels,
        time,
        memberName: noMembers,
      }).then(
        () => "saved",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      const error = await outcome;
      // A slow connection, which the menu does not report as a bug.
      expect(isConnectionFailure(error)).toBe(true);
      expect((error as Error).cause).toEqual(new Error("Peer history page timed out."));
      expect(download).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a page's own failure as it is", async () => {
    const failure = new Error("Bad page");
    const messages = vi.fn(async () => {
      throw failure;
    });
    const rpc = { threads: { messages } } as unknown as RpcClient;
    await expect(
      exportChat({ rpc, target: { kind: "bot", chat: bot }, labels, time, memberName: noMembers }),
    ).rejects.toBe(failure);
    expect(isConnectionFailure(failure)).toBe(false);
  });

  it("words a routine's event in the chat's words", async () => {
    const { rpc } = rpcWith([
      {
        messages: [
          message("Digest is on", {}),
          message("", {
            blocks: [{ kind: "routine_event", change: "disabled", name: "Digest" }],
          }),
        ],
        olderCursor: null,
      },
    ]);
    await exportChat({
      rpc,
      target: { kind: "bot", chat: bot },
      labels,
      time,
      memberName: noMembers,
    });
    expect(exported().text).toContain('disabled routine "Digest"');
  });

  it("saves nothing when a page fails to load", async () => {
    const messages = vi
      .fn()
      .mockResolvedValueOnce({ threadId: "t_1", messages: [message("Newest")], olderCursor: 5 })
      .mockRejectedValueOnce(new Error("offline"));
    const rpc = { threads: { messages } } as unknown as RpcClient;
    await expect(
      exportChat({ rpc, target: { kind: "bot", chat: bot }, labels, time, memberName: noMembers }),
    ).rejects.toThrow("offline");
    expect(download).not.toHaveBeenCalled();
  });

  it("fails instead of saving a history it stopped reading", async () => {
    const messages = vi.fn(async () => ({
      threadId: "t_1",
      messages: [message("Again")],
      olderCursor: 1,
    }));
    const rpc = { threads: { messages } } as unknown as RpcClient;
    await expect(
      exportChat({ rpc, target: { kind: "bot", chat: bot }, labels, time, memberName: noMembers }),
    ).rejects.toBeInstanceOf(ChatTooLongError);
    expect(download).not.toHaveBeenCalled();
  });
});

describe("chatExportFileName", () => {
  it("turns a chat's name into a file name in any script, with a fallback", () => {
    expect(chatExportFileName("Ada's inbox  (work)")).toBe("ada-s-inbox-work-chat.md");
    expect(chatExportFileName("研究 ボット")).toBe("研究-ボット-chat.md");
    // Hindi letters carry vowel signs (combining marks); they are part of the name, not separators.
    expect(chatExportFileName("हिन्दी ब्लॉग")).toBe("हिन्दी-ब्लॉग-chat.md");
    expect(chatExportFileName("???")).toBe("chat.md");
  });
});
