// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  boards: { subscribe: vi.fn() },
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
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));
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
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    Dialog: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  };
});

import { BoardPage } from "./Board";

function bot(id: string, name: string) {
  return { id, name };
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
    priority: "normal",
    assigneeBotId,
    createdByBotId: null,
    createdByUserId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
  };
}

async function renderBoard() {
  api.boards.subscribe.mockReset();
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

it("renders status columns and opens a ticket with comments", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [ticket("Ship", "ticket-1", "todo", "RAK-1", "bot-1", "Details")],
  });
  api.tickets.comments.mockResolvedValue([{ id: "comment-1", body: "Ready" }]);
  const page = await renderBoard();
  try {
    expect(
      Array.from(page.container.querySelectorAll("h2")).map((node) => node.textContent),
    ).toEqual(["To do", "In progress", "In review", "Blocked", "Done", "Won't do"]);
    await act(async () =>
      (
        page.container.querySelector('[data-testid="board-card-ticket-1"]') as HTMLButtonElement
      ).click(),
    );
    expect(page.container.querySelector('[data-testid="ticket-description"]')?.textContent).toBe(
      "Details",
    );
    expect(page.container.querySelector('[data-testid="ticket-comments"]')?.textContent).toContain(
      "Ready",
    );
    expect(api.tickets.comments).toHaveBeenCalledWith({ ticketId: "ticket-1" });
  } finally {
    await page.cleanup();
  }
});

it("creates a ticket without a status picker", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({ tickets: [] });
  api.tickets.create.mockResolvedValue({});
  const page = await renderBoard();
  try {
    await act(async () =>
      Array.from(page.container.querySelectorAll("button"))
        .find((button) => button.textContent === "New ticket")!
        .click(),
    );
    expect(
      Array.from(page.container.querySelectorAll("label")).map((label) => label.textContent),
    ).not.toContain("Status");
    const input = page.container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Launch",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      page.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.tickets.create).toHaveBeenCalledWith({
      title: "Launch",
      description: "",
      assigneeBotId: "bot-1",
      priority: "normal",
    });
  } finally {
    await page.cleanup();
  }
});
