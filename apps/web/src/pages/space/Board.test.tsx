// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred, flush } from "@rakazo/core/test-async";
import type * as UiWeb from "@rakazo/ui-web";
import { toast } from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

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
vi.mock("../../lib/query/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("../../lib/locale/relative-time", () => ({ formatRelativeTime: () => "5m ago" }));
vi.mock("../../components/WindowChrome", () => ({ WindowChrome: () => null }));
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
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const actual = await importOriginal<typeof UiWeb>();
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ...actual,
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    Dialog: ({
      children,
      onOpenChange,
    }: {
      children?: ReactNode;
      onOpenChange: (open: boolean) => void;
    }) => (
      <div>
        {children}
        <button type="button" aria-label="Close" onClick={() => onOpenChange(false)} />
      </div>
    ),
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    toast: { error: vi.fn() },
  };
});

import { BoardPage } from "./Board";

/** Query results reach components on a timer, real or fake. */
async function settle() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await flush();
  });
}

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

let client: QueryClient;
beforeEach(() => {
  // Retry and reconnect waits are jittered; pin them to their unjittered values.
  vi.spyOn(Math, "random").mockReturnValue(0);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

async function renderBoard(stream?: AsyncIterable<{ ticketId?: string }>, refusal?: unknown) {
  api.boards.subscribe.mockReset();
  api.boards.subscribe.mockResolvedValue(
    stream ?? {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    },
  );
  if (refusal) api.boards.subscribe.mockRejectedValueOnce(refusal);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/app/board"]}>
          <BoardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  // Let query results reach the screen.
  await settle();
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
  api.tickets.comments.mockResolvedValue([
    {
      id: "comment-1",
      body: "Ready",
      authorName: "Board tester",
      createdAt: "2026-10-10T10:00:00Z",
    },
    { id: "comment-2", body: "Reviewed", authorName: "Helper", createdAt: "2026-10-10T10:01:00Z" },
  ]);
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
    await settle();
    expect(page.container.querySelector('[data-testid="ticket-description"]')?.textContent).toBe(
      "Details",
    );
    expect(page.container.querySelector('[data-testid="ticket-comments"]')?.textContent).toContain(
      "Ready",
    );
    const comments = page.container.querySelector('[data-testid="ticket-comments"]')!;
    expect(comments.textContent).toContain("Board tester");
    expect(comments.textContent).toContain("Helper");
    expect(Array.from(comments.querySelectorAll("time")).map((node) => node.textContent)).toEqual([
      "5m ago",
      "5m ago",
    ]);
    expect(
      Array.from(page.container.querySelectorAll('form [role="combobox"]')).every((node) =>
        node.classList.contains("w-full"),
      ),
    ).toBe(true);
    const submitButtons = page.container.querySelectorAll('button[type="submit"]');
    expect(Array.from(submitButtons).map((node) => node.textContent)).toEqual(["Comment"]);
    expect(api.tickets.comments).toHaveBeenCalledWith({ ticketId: "ticket-1" }, expect.anything());
  } finally {
    await page.cleanup();
  }
});

it("returns a dragged ticket to its column when the status change fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [ticket("Ship", "ticket-1", "todo", "RAK-1", "bot-1")],
  });
  const moving = deferred();
  api.tickets.comments.mockReset().mockResolvedValue([]);
  api.tickets.update.mockReset().mockReturnValue(moving.promise);
  const page = await renderBoard();
  try {
    const card = () => page.container.querySelector('[data-testid="board-card-ticket-1"]')!;
    const done = page.container.querySelector('[aria-labelledby="board-column-done"]')!;
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type),
    };
    const dragEvent = (type: string) =>
      Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer });

    await act(async () => card().dispatchEvent(dragEvent("dragstart")));
    await act(async () => done.dispatchEvent(dragEvent("drop")));
    expect(api.tickets.update).toHaveBeenCalledExactlyOnceWith({
      id: "ticket-1",
      status: "done",
    });
    expect(card().parentElement).toBe(done);
    await act(async () => (card() as HTMLButtonElement).click());
    const status = page.container.querySelector<HTMLButtonElement>('[id$="-status"]')!;
    expect(status.textContent).toBe("Done");
    expect(status.disabled).toBe(true);

    await act(async () => moving.reject(new TypeError("Failed to fetch")));
    expect(card().parentElement?.getAttribute("aria-labelledby")).toBe("board-column-todo");
    expect(status.textContent).toBe("To do");
    expect(status.disabled).toBe(false);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("Could not reach the server");
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("creates a ticket without a status picker", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({ tickets: [] });
  api.tickets.create.mockResolvedValue({});
  const page = await renderBoard();
  try {
    expect(page.container.textContent).toContain("No tickets yet");
    await act(async () =>
      Array.from(page.container.querySelectorAll("button"))
        .find((button) => button.textContent === "New ticket")!
        .click(),
    );
    expect(
      Array.from(page.container.querySelectorAll("label")).map((label) => label.textContent),
    ).not.toContain("Status");
    const input = page.container.querySelector<HTMLInputElement>('input[id$="-title"]')!;
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

function liveStream() {
  let pending: Deferred<IteratorResult<{ ticketId?: string }>> | undefined;
  return {
    stream: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          pending = deferred();
          return pending.promise;
        },
      }),
    },
    event: (ticketId: string) => pending?.resolve({ done: false, value: { ticketId } }),
    end: () => pending?.resolve({ done: true, value: undefined }),
    error: () => pending?.reject(new Error("Disconnected")),
  };
}

it("saves only edits and refreshes comments for the open ticket", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper"), bot("bot-2", "Other")]);
  api.tickets.list.mockResolvedValue({
    tickets: [ticket("Ship", "ticket-1", "todo", "RAK-1", "bot-1", "Details")],
  });
  api.tickets.comments.mockReset().mockResolvedValue([{ id: "comment-1", body: "Ready" }]);
  api.tickets.update.mockReset().mockResolvedValue({});
  const live = liveStream();
  const page = await renderBoard(live.stream);
  try {
    await act(async () =>
      (
        page.container.querySelector('[data-testid="board-card-ticket-1"]') as HTMLButtonElement
      ).click(),
    );
    await settle();
    const description = page.container.querySelector<HTMLTextAreaElement>(
      '[data-testid="ticket-description"]',
    )!;
    async function editDescription(value: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          description,
          value,
        );
        description.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await editDescription("Draft details");
    const calls = api.tickets.comments.mock.calls.length;
    await act(async () => live.event("ticket-2"));
    expect(api.tickets.comments).toHaveBeenCalledTimes(calls);
    api.tickets.comments.mockResolvedValue([{ id: "comment-2", body: "Bot progress" }]);
    api.tickets.list.mockResolvedValue({
      tickets: [ticket("Ship", "ticket-1", "doing", "RAK-1", "bot-2", "Bot updated the details")],
    });
    await act(async () => live.event("ticket-1"));
    await settle();
    expect(page.container.querySelector('[data-testid="ticket-comments"]')?.textContent).toContain(
      "Bot progress",
    );
    expect(description.value).toBe("Draft details");
    await editDescription("Details");
    expect(description.value).toBe("Bot updated the details");

    const input = page.container.querySelector<HTMLInputElement>('input[id$="-title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Ship today",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      page.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.tickets.update).toHaveBeenCalledWith({ id: "ticket-1", title: "Ship today" });
  } finally {
    await page.cleanup();
  }
});

it("closes the subscription before retrying a failed ticket refresh", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list
    .mockReset()
    .mockResolvedValueOnce({ tickets: [] })
    .mockRejectedValueOnce(new Error("Refresh failed"))
    .mockResolvedValue({ tickets: [ticket("After retry", "ticket-1")] });
  const next = vi.fn(() => new Promise<IteratorResult<{ ticketId?: string }>>(() => {}));
  const page = await renderBoard({ [Symbol.asyncIterator]: () => ({ next }) });
  try {
    const firstSignal = api.boards.subscribe.mock.calls[0]![1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(api.boards.subscribe).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(api.boards.subscribe).toHaveBeenCalledTimes(2);
    const retrySignal = api.boards.subscribe.mock.calls[1]![1].signal as AbortSignal;
    expect(retrySignal).not.toBe(firstSignal);
    expect(retrySignal.aborted).toBe(false);
    expect(page.container.textContent).toContain("After retry");

    await page.cleanup();
    expect(retrySignal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(api.boards.subscribe).toHaveBeenCalledTimes(2);
  } finally {
    if (page.container.isConnected) await page.cleanup();
    vi.useRealTimers();
  }
});

it.each(["end", "error"] as const)(
  "reconnects after subscription %s and stops on unmount",
  async (failure) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
    api.tickets.list.mockReset().mockResolvedValue({ tickets: [] });
    const live = liveStream();
    const page = await renderBoard(live.stream);
    try {
      const reconnected = liveStream();
      api.boards.subscribe.mockResolvedValue(reconnected.stream);
      await act(async () => live[failure]());
      const calls = api.tickets.list.mock.calls.length;
      api.tickets.list.mockResolvedValue({ tickets: [ticket("After reconnect", "ticket-1")] });
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      await settle();
      expect(api.boards.subscribe).toHaveBeenCalledTimes(2);
      expect(api.tickets.list).toHaveBeenCalledTimes(calls + 1);
      await act(async () => {
        await vi.waitFor(() => expect(page.container.textContent).toContain("After reconnect"));
      });
      await act(async () => reconnected.end());
      await page.cleanup();
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(api.boards.subscribe).toHaveBeenCalledTimes(2);
      expect(api.boards.subscribe.mock.calls[1]![1].signal.aborted).toBe(true);
    } finally {
      if (page.container.isConnected) await page.cleanup();
      vi.useRealTimers();
    }
  },
);

it.each([
  [403, 1],
  [404, 1],
  [503, 2],
])("after a %i subscribing, reconnect attempts total %i", async (status, attempts) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  api.bots.list.mockResolvedValue([]);
  api.tickets.list.mockReset().mockResolvedValue({ tickets: [] });
  const page = await renderBoard(undefined, Object.assign(new Error("Refused"), { status }));
  try {
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(api.boards.subscribe).toHaveBeenCalledTimes(attempts);
  } finally {
    await page.cleanup();
    vi.useRealTimers();
  }
});

it("renders the back control as a plain link", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([]);
  api.tickets.list.mockResolvedValue({ tickets: [] });
  const page = await renderBoard();
  try {
    const back = page.container.querySelector('a[href="/app"]');
    if (!back) throw new Error("Missing back link");
    expect(back.hasAttribute("type")).toBe(false);
    expect(back.hasAttribute("role")).toBe(false);
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("reopens with cached tickets and refreshes them in the background", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockReset().mockResolvedValue({ tickets: [ticket("Cached", "ticket-1")] });
  const first = await renderBoard();
  expect(first.container.textContent).toContain("Cached");
  await first.cleanup();
  await client.invalidateQueries();

  let finish: Deferred<{ tickets: ReturnType<typeof ticket>[] }> | undefined;
  api.tickets.list.mockImplementation(() => {
    finish = deferred();
    return finish.promise;
  });
  const page = await renderBoard();
  try {
    // Painted from the cache while the refresh is still out.
    expect(page.container.textContent).toContain("Cached");
    await act(async () => finish?.resolve({ tickets: [ticket("Fresh", "ticket-1")] }));
    await act(async () => {
      await vi.waitFor(() => expect(page.container.textContent).toContain("Fresh"));
    });
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

async function openTicketAndComment(page: { container: HTMLElement }, text: string) {
  await act(async () =>
    (
      page.container.querySelector('[data-testid="board-card-ticket-1"]') as HTMLButtonElement
    ).click(),
  );
  await settle();
  const box = page.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = box.closest("form")!;
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

function commentsText(page: { container: HTMLElement }) {
  return page.container.querySelector('[data-testid="ticket-comments"]')?.textContent ?? "";
}

it("shows every comment when one is posted before the first read lands", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [ticket("Ship", "ticket-1", "todo", "RAK-1", "bot-1")],
  });
  const posted = { id: "comment-2", body: "New note", createdAt: "2026-10-10T10:01:00Z" };
  const earlier = { id: "comment-1", body: "Ready", createdAt: "2026-10-10T10:00:00Z" };
  // The first read never answers; the read after posting has both.
  api.tickets.comments
    .mockReset()
    .mockImplementationOnce(() => new Promise(() => undefined))
    .mockResolvedValue([earlier, posted]);
  api.tickets.comment.mockReset().mockResolvedValue(posted);
  const page = await renderBoard();
  try {
    await openTicketAndComment(page, "New note");
    await settle();
    await vi.waitFor(() => {
      expect(commentsText(page)).toContain("Ready");
      expect(commentsText(page)).toContain("New note");
    });
  } finally {
    await page.cleanup();
  }
});

it("does not repeat a posted comment a refresh already brought", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [ticket("Ship", "ticket-1", "todo", "RAK-1", "bot-1")],
  });
  const earlier = { id: "comment-1", body: "Ready", createdAt: "2026-10-10T10:00:00Z" };
  const posted = { id: "comment-2", body: "New note", createdAt: "2026-10-10T10:01:00Z" };
  api.tickets.comments.mockReset().mockResolvedValue([earlier]);
  let answerPost!: Deferred<typeof posted>;
  api.tickets.comment.mockReset().mockImplementation(() => {
    answerPost = deferred();
    return answerPost.promise;
  });
  const live = liveStream();
  const page = await renderBoard(live.stream);
  try {
    await openTicketAndComment(page, "New note");
    // A live refresh lands with the new comment before the post answers.
    api.tickets.comments.mockResolvedValue([earlier, posted]);
    await act(async () => live.event("ticket-1"));
    await settle();
    expect(commentsText(page)).toContain("New note");
    // Every later read hangs, so only the post's own write can change the list now.
    api.tickets.comments.mockImplementation(() => new Promise(() => undefined));
    await act(async () => answerPost.resolve(posted));
    await settle();
    expect(commentsText(page).split("New note")).toHaveLength(2);
  } finally {
    await page.cleanup();
  }
});

async function openNewTicket(page: { container: HTMLElement }, title: string) {
  await act(async () =>
    Array.from(page.container.querySelectorAll("button"))
      .find((button) => button.textContent === "New ticket")!
      .click(),
  );
  const input = page.container.querySelector<HTMLInputElement>('input[id$="-title"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, title);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = page.container.querySelector("form")!;
  return {
    submit: () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    create: () =>
      Array.from(page.container.querySelectorAll("button")).find(
        (button) => button.textContent === "Create",
      ),
  };
}

it("creates one ticket when submitted twice, holds the form meanwhile, then lists it and closes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockReset().mockResolvedValue({ tickets: [] });
  const creating = deferred<object>();
  api.tickets.create.mockReset().mockReturnValue(creating.promise);
  const page = await renderBoard();
  try {
    const form = await openNewTicket(page, "Launch");
    await act(async () => {
      form.submit();
      form.submit();
    });
    expect(api.tickets.create).toHaveBeenCalledTimes(1);
    expect(form.create()?.disabled).toBe(true);

    const reads = api.tickets.list.mock.calls.length;
    api.tickets.list.mockResolvedValue({ tickets: [ticket("Launch", "ticket-1")] });
    await act(async () => creating.resolve({}));
    await settle();
    expect(api.tickets.list).toHaveBeenCalledTimes(reads + 1);
    expect(form.create()).toBeUndefined();
    expect(page.container.querySelector('[data-testid="board-card-ticket-1"]')).not.toBeNull();
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows why a ticket was not saved and offers the form again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockReset().mockResolvedValue({ tickets: [] });
  api.tickets.create.mockReset().mockRejectedValue(new TypeError("Failed to fetch"));
  const page = await renderBoard();
  try {
    const form = await openNewTicket(page, "Launch");
    await act(async () => form.submit());
    await settle();
    expect(page.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not reach the server",
    );
    expect(form.create()?.disabled).toBe(false);
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("closes a saved ticket even when the board cannot be read again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockReset().mockResolvedValue({ tickets: [] });
  api.tickets.create.mockReset().mockResolvedValue({});
  const page = await renderBoard();
  try {
    const form = await openNewTicket(page, "Launch");
    api.tickets.list.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => form.submit());
    await settle();
    // Left open with an error, a second Create would add the ticket twice.
    expect(form.create()).toBeUndefined();
    expect(api.tickets.create).toHaveBeenCalledTimes(1);
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

async function selectHighPriority(container: HTMLElement) {
  const priority = container.querySelector<HTMLButtonElement>('[id$="-priority"]')!;
  await act(async () => priority.click());
  const high = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (option) => option.textContent === "High",
  )!;
  await act(async () => high.click());
  return priority;
}

it("keeps a live ticket update when an older save response has the same timestamp", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  const original = ticket("Ship", "ticket-1", "todo", "RAK-1", "bot-1");
  const saved = { ...original, priority: "high" };
  const liveTicket = { ...saved, title: "Ship today", status: "doing" };
  const response = deferred<typeof saved>();
  api.tickets.list.mockReset().mockResolvedValue({ tickets: [original] });
  api.tickets.comments.mockReset().mockResolvedValue([]);
  api.tickets.update.mockReset().mockReturnValue(response.promise);
  const live = liveStream();
  const page = await renderBoard(live.stream);
  try {
    const card = () =>
      page.container.querySelector<HTMLButtonElement>('[data-testid="board-card-ticket-1"]')!;
    await act(async () => card().click());
    const priority = await selectHighPriority(page.container);

    api.tickets.list.mockResolvedValue({ tickets: [liveTicket] });
    await act(async () => live.event(original.id));
    await settle();
    expect(card().textContent).toContain("Ship today");

    api.tickets.list.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => response.resolve(saved));
    await settle();
    expect(priority.disabled).toBe(false);
    expect(card().textContent).toContain("Ship today");
    expect(card().parentElement?.getAttribute("aria-labelledby")).toBe("board-column-doing");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("reports a failed dropdown save after the ticket dialog closes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(toast.error).mockClear();
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  const original = ticket("Ship", "ticket-1", "todo", "RAK-1", "bot-1");
  const response = deferred();
  api.tickets.list.mockReset().mockResolvedValue({ tickets: [original] });
  api.tickets.comments.mockReset().mockResolvedValue([]);
  api.tickets.update.mockReset().mockReturnValue(response.promise);
  const page = await renderBoard();
  try {
    const card = page.container.querySelector<HTMLButtonElement>(
      '[data-testid="board-card-ticket-1"]',
    )!;
    await act(async () => card.click());
    await selectHighPriority(page.container);
    const close = page.container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    await act(async () => close.click());
    expect(page.container.querySelector('[id$="-priority"]')).toBeNull();

    await act(async () => response.reject(new TypeError("Failed to fetch")));
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("Could not reach the server");
    expect(card.textContent).not.toContain("High");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("clears an earlier comment error before saving a dropdown choice", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  const original = ticket("Ship", "ticket-1", "todo", "RAK-1", "bot-1");
  const updated = { ...original, priority: "high" };
  api.tickets.list.mockReset().mockResolvedValue({ tickets: [original] });
  api.tickets.comments.mockReset().mockResolvedValue([]);
  api.tickets.comment.mockReset().mockRejectedValue(new TypeError("Failed to fetch"));
  api.tickets.update.mockReset().mockImplementation(async () => {
    api.tickets.list.mockResolvedValue({ tickets: [updated] });
    return updated;
  });
  const page = await renderBoard();
  try {
    await openTicketAndComment(page, "A draft comment");
    expect(page.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not reach the server",
    );

    const priority = await selectHighPriority(page.container);
    await settle();

    expect(api.tickets.update).toHaveBeenCalledExactlyOnceWith({
      id: "ticket-1",
      priority: "high",
    });
    expect(priority.textContent).toBe("High");
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
    expect(
      page.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')?.value,
    ).toBe("A draft comment");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("holds the comment box while a comment posts, and says when it fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockReset().mockResolvedValue({
    tickets: [ticket("Ship", "ticket-1", "todo", "RAK-1", "bot-1")],
  });
  api.tickets.comments.mockReset().mockResolvedValue([]);
  const posting = deferred<object>();
  api.tickets.comment.mockReset().mockReturnValue(posting.promise);
  const page = await renderBoard();
  try {
    await openTicketAndComment(page, "New note");
    const box = page.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]');
    const post = () =>
      Array.from(page.container.querySelectorAll("button")).find(
        (button) => button.textContent === "Comment",
      );
    expect(post()?.disabled).toBe(true);
    await act(async () =>
      box!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.tickets.comment).toHaveBeenCalledTimes(1);

    await act(async () => posting.reject(new TypeError("Failed to fetch")));
    await settle();
    expect(page.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not reach the server",
    );
    expect(post()?.disabled).toBe(false);
    expect(box?.value).toBe("New note");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});
