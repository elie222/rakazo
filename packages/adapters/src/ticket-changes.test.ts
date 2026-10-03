import { describe, expect, it, vi } from "vitest";
import { createTicketChangeNotifier, type TicketChange } from "./ticket-changes.js";

function notifier() {
  const notify = vi.fn(async () => undefined);
  const enqueue = vi.fn(async () => undefined);
  return {
    notify,
    enqueue,
    changes: createTicketChangeNotifier({
      boardEvents: { notify, follow: vi.fn() } as never,
      jobs: { enqueue, cancel: vi.fn(), close: vi.fn() } as never,
    }),
  };
}

const base: TicketChange = {
  spaceId: "space-1",
  boardId: "board-1",
  ticketId: "ticket-1",
  assigneeBotId: "bot-2",
  actorBotId: null,
  wakeAssignee: true,
};

describe("createTicketChangeNotifier", () => {
  it("always publishes the board change signal", async () => {
    const { changes, notify, enqueue } = notifier();
    await changes(base);
    expect(notify).toHaveBeenCalledWith("space-1", {
      boardId: "board-1",
      ticketId: "ticket-1",
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("wakes the new owner when a human or another bot assigns the ticket", async () => {
    const { changes, enqueue } = notifier();
    await changes({ ...base, actorBotId: "bot-1" });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "tickets.check", payload: { botId: "bot-2" } }),
    );
  });

  it("does not wake a bot that assigned the ticket to itself", async () => {
    const { changes, enqueue } = notifier();
    await changes({ ...base, actorBotId: "bot-2" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not wake anyone for a plain update", async () => {
    const { changes, enqueue } = notifier();
    await changes({ ...base, wakeAssignee: false });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
