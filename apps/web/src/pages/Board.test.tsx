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
  },
}));
vi.mock("../lib/rpc", () => ({ rpc: api }));
vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "just now" }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
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
    BotAvatar: () => <span />,
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    Dialog: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DropdownMenu: Container,
    DropdownMenuContent: Container,
    DropdownMenuItem: Container,
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

async function renderBoard() {
  window.localStorage.clear();
  // The live stream never yields in tests; the board renders from the initial list.
  api.boards.subscribe.mockResolvedValue({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  });
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

it("renders readable status columns with tickets and a collapsed closed column", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [ticket("Fix the thing", "ticket-1", "todo", "RAK-1", "bot-1")],
    workingBotIds: [],
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
    expect(closed?.textContent).toContain("Closed");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows a work indicator on cards owned by a bot running a ticket wake", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.boards.list.mockResolvedValue([boardStub()]);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper"), bot("bot-2", "Idle")]);
  api.tickets.list.mockResolvedValue({
    tickets: [
      ticket("Working thing", "ticket-1", "todo", "RAK-1", "bot-1"),
      ticket("Waiting thing", "ticket-2", "todo", "RAK-2", "bot-2"),
    ],
    workingBotIds: ["bot-1"],
  });
  const page = await renderBoard();
  try {
    const cards = page.container.querySelectorAll("[data-testid='board-card-ticket-1']");
    const workingCards = page.container.querySelectorAll("[data-testid='ticket-working']");
    expect(cards.length).toBe(1);
    expect(workingCards.length).toBe(1);
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
    workingBotIds: [],
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
    workingBotIds: [],
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
  api.tickets.list.mockResolvedValue({ tickets: [], workingBotIds: [] });
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
