// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  boards: { list: vi.fn(), get: vi.fn(), subscribe: vi.fn() },
  bots: { list: vi.fn() },
  tickets: {
    list: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    comment: vi.fn(),
    comments: vi.fn(),
    events: vi.fn(),
  },
}));
vi.mock("../lib/rpc", () => ({ rpc: api }));
vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "just now" }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => (
    <div data-testid="chat-markdown">{children}</div>
  ),
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Badge: Container,
    BotAvatar: ({ status }: { status?: string }) => (
      <span data-testid="bot-avatar" data-status={status} />
    ),
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    Dialog: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DropdownMenu: Container,
    DropdownMenuContent: Container,
    DropdownMenuItem: ({ children, onClick, disabled }: ComponentProps<"button">) => (
      <button type="button" role="menuitem" onClick={onClick} disabled={disabled}>
        {children}
      </button>
    ),
    DropdownMenuTrigger: Container,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Select: Container,
    SelectContent: Container,
    SelectItem: Container,
    SelectTrigger: Container,
    SelectValue: Container,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  };
});

import { BoardPage } from "./Board";

function bot(id: string, name: string) {
  return {
    id,
    spaceId: "space-1",
    name,
    title: "",
    description: "",
    instructions: "",
    color: "#111111",
    notifyOnFinish: false,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: `thread-${id}`,
    preview: "",
    status: "idle",
    computerMode: "off",
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    spawnKey: null,
  };
}

function ticket(
  title: string,
  id: string,
  status = "todo",
  ref = "RAK-1",
  assigneeBotId: string | null = null,
  description: string | null = null,
) {
  return {
    id,
    boardId: "board-1",
    spaceId: "space-1",
    number: 1,
    ref,
    title,
    description,
    acceptanceCriteria: [] as { text: string; done: boolean }[],
    statusChangedAt: new Date().toISOString(),
    status,
    priority: null,
    assigneeBotId,
    createdByBotId: null,
    createdByUserId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
  };
}

async function renderBoard(subscribe?: AsyncIterable<unknown>) {
  window.localStorage.clear();
  // The live stream never yields in tests unless a case supplies one event.
  api.boards.subscribe.mockReset();
  api.boards.subscribe.mockResolvedValue(
    subscribe ?? {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/app/board"]}>
        <BoardPage />
      </MemoryRouter>,
    ),
  );
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function boardStub() {
  return {
    id: "board-1",
    spaceId: "space-1",
    name: "Personal",
    ticketPrefix: "RAK",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

it("renders readable status columns with tickets and collapsed done and won't-do columns", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [ticket("Fix the thing", "ticket-1", "todo", "RAK-1", "bot-1")],
    workingTicketIds: [],
    botIssues: [],
  });
  const page = await renderBoard();
  try {
    for (const status of ["todo", "doing", "review", "blocked", "done", "closed"]) {
      expect(page.container.querySelector(`[data-testid='board-column-${status}']`)).toBeTruthy();
    }
    expect(page.container.textContent).toContain("To do");
    expect(page.container.textContent).toContain("In progress");
    expect(page.container.textContent).toContain("Fix the thing");
    expect(page.container.textContent).toContain("RAK-1");
    expect(page.container.textContent).toContain("Helper");

    const closed = page.container.querySelector("[data-testid='board-column-closed']");
    expect(closed?.getAttribute("data-collapsed")).toBe("true");
    expect(closed?.textContent).toContain("Won't do");
    expect(
      page.container
        .querySelector("[data-testid='board-column-done']")
        ?.getAttribute("data-collapsed"),
    ).toBe("true");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows the work indicator only on the ticket the bot is working on", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper"), bot("bot-2", "Idle")]);
  api.tickets.list.mockResolvedValue({
    tickets: [
      ticket("Working thing", "ticket-1", "todo", "RAK-1", "bot-1"),
      ticket("Waiting thing", "ticket-2", "todo", "RAK-2", "bot-2"),
      // Same bot, but not the ticket it is on: must not spin.
      ticket("Queued thing", "ticket-3", "todo", "RAK-3", "bot-1"),
    ],
    workingTicketIds: ["ticket-1"],
    botIssues: [],
  });
  const page = await renderBoard();
  try {
    const cards = page.container.querySelectorAll("[data-testid='board-card-ticket-1']");
    const workingCards = page.container.querySelectorAll("[data-testid='ticket-working']");
    expect(cards.length).toBe(1);
    expect(workingCards.length).toBe(1);
    // The avatar's own spinner follows the bot's status for any active run (even one
    // parked on a person), so the board must not feed it or every card would spin.
    for (const avatar of page.container.querySelectorAll("[data-testid='bot-avatar']")) {
      expect(avatar.getAttribute("data-status")).toBeNull();
    }
    expect(
      page.container
        .querySelector("[data-testid='board-card-ticket-1']")
        ?.querySelector("[data-testid='ticket-working']"),
    ).toBeTruthy();
    expect(workingCards[0]?.getAttribute("aria-label")).toContain("is working");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("renders the ticket description and comments as markdown and toggles editing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const description = "## Steps\n\n- one\n- two";
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [ticket("Fix the thing", "ticket-1", "todo", "RAK-1", "bot-1", description)],
    workingTicketIds: [],
    botIssues: [],
  });
  api.tickets.comments.mockResolvedValue([
    {
      id: "comment-1",
      ticketId: "ticket-1",
      authorBotId: "bot-1",
      body: "**Working** on it",
      createdAt: new Date().toISOString(),
    },
  ]);
  api.tickets.update.mockResolvedValue(undefined);
  const page = await renderBoard();
  try {
    await act(async () => {
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='board-card-ticket-1']")
        ?.click();
    });

    const rendered = page.container.querySelector("[data-testid='ticket-description']");
    expect(rendered?.textContent).toContain(description);
    expect(page.container.querySelector("[data-testid='ticket-description-input']")).toBeNull();
    expect(page.container.querySelector("[data-testid='ticket-comments']")?.textContent).toContain(
      "**Working** on it",
    );

    await act(async () => {
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='ticket-description-edit']")
        ?.click();
    });
    const input = page.container.querySelector<HTMLTextAreaElement>(
      "[data-testid='ticket-description-input']",
    );
    expect(input?.value).toBe(description);
    expect(page.container.querySelector("[data-testid='ticket-description']")).toBeNull();
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("drops the status field from the new-ticket form and flags urgent tickets", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [
      { ...ticket("Urgent thing", "ticket-1", "todo", "RAK-1", "bot-1"), priority: "urgent" },
      { ...ticket("Plain thing", "ticket-2", "todo", "RAK-2", "bot-1"), priority: "normal" },
    ],
    workingTicketIds: [],
    botIssues: [],
  });
  const page = await renderBoard();
  try {
    const urgentCard = page.container.querySelector("[data-testid='board-card-ticket-1']");
    expect(urgentCard?.textContent).toContain("Urgent");
    const normalCard = page.container.querySelector("[data-testid='board-card-ticket-2']");
    expect(normalCard?.textContent).not.toContain("Normal");

    expect(page.container.querySelector("select[aria-label='Status']")).toBeNull();
    const priority = page.container.querySelector("select[aria-label='Priority']");
    expect(priority?.textContent).toContain("Low");
    expect(priority?.textContent).toContain("Urgent");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("expands the closed column and remembers the choice", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({ tickets: [], workingTicketIds: [], botIssues: [] });
  const page = await renderBoard();
  try {
    const collapsed = page.container.querySelector<HTMLButtonElement>(
      "[data-testid='board-column-closed']",
    );
    expect(collapsed?.getAttribute("data-collapsed")).toBe("true");
    await act(async () => collapsed?.click());
    const expanded = page.container.querySelector("[data-testid='board-column-closed']");
    expect(expanded?.getAttribute("data-collapsed")).toBeNull();
    expect(window.localStorage.getItem("rakazo:board-closed-collapsed")).toBe("open");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("reloads the board name when a live update arrives", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list
    .mockResolvedValueOnce([boardStub()])
    .mockResolvedValue([{ ...boardStub(), name: "Launch" }]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({ tickets: [], workingTicketIds: [], botIssues: [] });
  const page = await renderBoard({
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        async next() {
          if (!sent) {
            sent = true;
            return { value: { spaceId: "space-1" }, done: false as const };
          }
          return new Promise<IteratorResult<unknown>>(() => {});
        },
      };
    },
  });
  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(page.container.textContent).toContain("Launch");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("keeps the newer board name when an older reload finishes last", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pending: Array<(boards: ReturnType<typeof boardStub>[]) => void> = [];
  let calls = 0;
  api.boards.list.mockImplementation(
    () =>
      new Promise((resolve) => {
        calls += 1;
        if (calls === 1) {
          resolve([boardStub()]);
          return;
        }
        pending.push(resolve);
      }),
  );
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({ tickets: [], workingTicketIds: [], botIssues: [] });
  const page = await renderBoard({
    [Symbol.asyncIterator]() {
      const events = [{ spaceId: "space-1" }, { spaceId: "space-1" }];
      return {
        async next() {
          const event = events.shift();
          if (event) return { value: event, done: false as const };
          return new Promise<IteratorResult<unknown>>(() => {});
        },
      };
    },
  });
  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1]?.([{ ...boardStub(), name: "Launch" }]);
    });
    expect(page.container.textContent).toContain("Launch");
    await act(async () => {
      pending[0]?.([{ ...boardStub(), name: "Stale" }]);
    });
    expect(page.container.textContent).toContain("Launch");
    expect(page.container.textContent).not.toContain("Stale");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows an error instead of failing silently when moving a ticket is rejected", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [ticket("Fix the thing", "ticket-1", "todo", "RAK-1", "bot-1")],
    workingTicketIds: [],
    botIssues: [],
  });
  api.tickets.update.mockRejectedValue(new Error("Ticket is locked"));
  const page = await renderBoard();
  try {
    const item = [...page.container.querySelectorAll<HTMLElement>("[role='menuitem']")].find((el) =>
      el.textContent?.includes("In progress"),
    );
    expect(item).toBeTruthy();
    await act(async () => item?.click());
    expect(api.tickets.update).toHaveBeenCalledWith({ id: "ticket-1", status: "doing" });
    expect(page.container.querySelector("[role='alert']")?.textContent).toBe("Ticket is locked");
    // The board stays visible; the error does not replace it.
    expect(page.container.textContent).toContain("Fix the thing");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("remembers expanding the done column separately", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({ tickets: [], workingTicketIds: [], botIssues: [] });
  const page = await renderBoard();
  try {
    await act(async () =>
      page.container.querySelector<HTMLButtonElement>("[data-testid='board-column-done']")?.click(),
    );
    expect(window.localStorage.getItem("rakazo:board-done-collapsed")).toBe("open");
    expect(window.localStorage.getItem("rakazo:board-closed-collapsed")).toBeNull();
    expect(
      page.container
        .querySelector("[data-testid='board-column-closed']")
        ?.getAttribute("data-collapsed"),
    ).toBe("true");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows criteria progress, a failing-bot marker and an over-limit warning", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  const withCriteria = {
    ...ticket("Checklist", "ticket-1", "todo", "RAK-1", "bot-1"),
    acceptanceCriteria: [
      { text: "A", done: true },
      { text: "B", done: false },
    ],
  };
  api.tickets.list.mockResolvedValue({
    tickets: [
      withCriteria,
      ...[2, 3, 4, 5].map((n) => ticket(`Doing ${n}`, `ticket-${n}`, "doing", `RAK-${n}`, "bot-1")),
    ],
    workingTicketIds: [],
    botIssues: [
      { botId: "bot-1", message: "Computer image missing", at: new Date().toISOString() },
    ],
  });
  const page = await renderBoard();
  try {
    const card = page.container.querySelector("[data-testid='board-card-ticket-1']");
    expect(card?.querySelector("[data-testid='ticket-criteria-progress']")?.textContent).toContain(
      "1/2",
    );
    expect(card?.querySelector("[data-testid='ticket-bot-issue']")?.getAttribute("title")).toBe(
      "Computer image missing",
    );
    expect(page.container.querySelectorAll("[data-testid='ticket-wip-warning']").length).toBe(4);
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("asks for a reason before moving to blocked, and sends it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [ticket("Fix the thing", "ticket-1", "doing", "RAK-1", "bot-1")],
    workingTicketIds: [],
    botIssues: [],
  });
  api.tickets.update.mockReset();
  api.tickets.update.mockResolvedValue(undefined);
  const page = await renderBoard();
  try {
    const item = [...page.container.querySelectorAll<HTMLElement>("[role='menuitem']")].find((el) =>
      el.textContent?.includes("Blocked"),
    );
    await act(async () => item?.click());
    expect(api.tickets.update).not.toHaveBeenCalled();
    const input = page.container.querySelector<HTMLTextAreaElement>(
      "[data-testid='move-reason-input']",
    );
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, "Waiting on API");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input?.closest("form")?.requestSubmit());
    expect(api.tickets.update).toHaveBeenCalledWith({
      id: "ticket-1",
      status: "blocked",
      reason: "Waiting on API",
    });
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("lists checkable criteria and the ticket history in the detail", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [
      {
        ...ticket("Fix the thing", "ticket-1", "doing", "RAK-1", "bot-1"),
        acceptanceCriteria: [{ text: "Deployed", done: false }],
      },
    ],
    workingTicketIds: [],
    botIssues: [],
  });
  api.tickets.comments.mockResolvedValue([]);
  api.tickets.events.mockResolvedValue([
    {
      id: "e1",
      ticketId: "ticket-1",
      type: "status_changed",
      actorBotId: "bot-1",
      actorUserId: null,
      data: { from: "todo", to: "doing" },
      createdAt: new Date().toISOString(),
    },
  ]);
  api.tickets.update.mockReset();
  api.tickets.update.mockResolvedValue(undefined);
  const page = await renderBoard();
  try {
    await act(async () =>
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='board-card-ticket-1']")
        ?.click(),
    );
    await act(async () =>
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='ticket-criterion-0']")
        ?.click(),
    );
    expect(api.tickets.update).toHaveBeenCalledWith({
      id: "ticket-1",
      acceptanceCriteria: [{ text: "Deployed", done: true }],
    });
    await act(async () =>
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='ticket-tab-history']")
        ?.click(),
    );
    expect(page.container.querySelector("[data-testid='ticket-history']")?.textContent).toContain(
      "Helper moved it from To do to In progress",
    );
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("sends only the toggled criterion with an explicit value", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [
      {
        ...ticket("Fix the thing", "ticket-1", "doing", "RAK-1", "bot-1"),
        acceptanceCriteria: [
          { text: "Deployed", done: false },
          { text: "Documented", done: false },
        ],
      },
    ],
    workingTicketIds: [],
    botIssues: [],
  });
  api.tickets.comments.mockResolvedValue([]);
  api.tickets.events.mockResolvedValue([]);
  api.tickets.update.mockReset();
  api.tickets.update.mockResolvedValue(undefined);
  const page = await renderBoard();
  try {
    await act(async () =>
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='board-card-ticket-1']")
        ?.click(),
    );
    await act(async () =>
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='ticket-criterion-1']")
        ?.click(),
    );
    // The untouched entry goes as plain text, so the server keeps whatever it
    // holds for it instead of writing back this page's older copy.
    expect(api.tickets.update).toHaveBeenCalledWith({
      id: "ticket-1",
      acceptanceCriteria: ["Deployed", { text: "Documented", done: true }],
    });
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("edits description and criteria as markdown and renders them after saving", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [
      {
        ...ticket("Fix the thing", "ticket-1", "todo", "RAK-1", "bot-1", "**bold** text"),
        acceptanceCriteria: [{ text: "Has `code`", done: false }],
      },
    ],
    workingTicketIds: [],
    botIssues: [],
  });
  api.tickets.comments.mockResolvedValue([]);
  api.tickets.events.mockResolvedValue([]);
  api.tickets.update.mockReset();
  api.tickets.update.mockResolvedValue(undefined);
  const page = await renderBoard();
  try {
    await act(async () =>
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='board-card-ticket-1']")
        ?.click(),
    );
    // Viewing: both fields go through the markdown renderer.
    expect(page.container.querySelector("[data-testid='ticket-criteria']")?.innerHTML).toContain(
      "chat-markdown",
    );
    await act(async () =>
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='ticket-description-edit']")
        ?.click(),
    );
    // Editing: raw markdown source, not rendered.
    const input = page.container.querySelector<HTMLTextAreaElement>(
      "[data-testid='ticket-description-input']",
    );
    expect(input?.value).toBe("**bold** text");
    expect(
      page.container.querySelector<HTMLTextAreaElement>("[data-testid='ticket-criteria-input']")
        ?.value,
    ).toBe("Has `code`");
    await act(async () =>
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='ticket-description-save']")
        ?.click(),
    );
    expect(api.tickets.update).toHaveBeenCalledWith({
      id: "ticket-1",
      title: "Fix the thing",
      description: "**bold** text",
      acceptanceCriteria: ["Has `code`"],
    });
    expect(page.container.querySelector("[data-testid='ticket-description-input']")).toBeNull();
    expect(page.container.querySelector("[data-testid='ticket-description']")).toBeTruthy();
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});
