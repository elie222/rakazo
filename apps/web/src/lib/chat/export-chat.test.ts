import type { Bot, Group, ThreadMessage } from "@rakazo/contracts";
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
