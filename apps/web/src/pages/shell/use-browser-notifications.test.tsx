// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "../../lib/i18n";
import { useBrowserNotifications } from "./use-browser-notifications";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("notifies for another agent's reply with its name and avatar, without replaying old unread chats", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  const notices: Array<{ title: string; options: NotificationOptions }> = [];
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      constructor(title: string, options: NotificationOptions) {
        notices.push({ title, options });
      }
    },
  );
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  const bot = {
    id: "marketing",
    name: "Head of Marketing",
    color: "#14b8a6",
    threadId: "thread",
    status: "completed",
    unread: true,
    preview: "Old reply",
    previewRole: "bot",
    notifyOnFinish: true,
    updatedAt: "old",
  } as Bot;
  function Harness({ bots }: { bots: Bot[] }) {
    const ref = useRef(bots);
    ref.current = bots;
    useBrowserNotifications(ref, bots, "chief", "space");
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness bots={[bot]} />));
    expect(notices).toHaveLength(0);
    await act(async () =>
      root.render(<Harness bots={[{ ...bot, preview: "Draft ready", updatedAt: "new" }]} />),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe("Head of Marketing");
    expect(notices[0]!.options).toMatchObject({
      tag: "thread",
      body: "Draft ready",
      icon: expect.stringMatching(/^data:image\//),
    });
    await act(async () =>
      root.render(<Harness bots={[{ ...bot, preview: "Draft ready", updatedAt: "new" }]} />),
    );
    expect(notices).toHaveLength(1);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () =>
      root.render(
        <Harness
          bots={[{ ...bot, preview: "Draft ready", status: "waiting_input", updatedAt: "ask" }]}
        />,
      ),
    );
    expect(notices).toHaveLength(2);
    expect(notices[1]!.options.body).toBe("Needs attention");
    await act(async () =>
      root.render(
        <Harness
          bots={[
            { ...bot, preview: "Draft ready", status: "idle", updatedAt: "idle", runErrorId: null },
          ]}
        />,
      ),
    );
    expect(notices).toHaveLength(2);
    await act(async () =>
      root.render(
        <Harness
          bots={[
            {
              ...bot,
              preview: "Draft ready",
              status: "idle",
              updatedAt: "failure",
              runErrorId: "failed-run",
            },
          ]}
        />,
      ),
    );
    await act(async () =>
      root.render(
        <Harness
          bots={[
            {
              ...bot,
              status: "waiting_input",
              activeRunThreadId: "group-thread",
              updatedAt: "group",
            },
          ]}
        />,
      ),
    );
    expect(notices).toHaveLength(3);
    expect(notices).toHaveLength(3);
    expect(notices[2]!.title).toBe("Head of Marketing failed");
  } finally {
    await act(async () => root.unmount());
  }
});

it.each(["run.waiting_input", "computer.takeover.requested", "run.failed"] as const)(
  "deduplicates %s between stream and a delayed roster transition",
  async (type) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const show = vi.fn();
    vi.stubGlobal(
      "Notification",
      class {
        static permission = "granted";
        constructor(title: string, options: NotificationOptions) {
          show(title, options);
        }
      },
    );
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const bot = {
      id: "agent",
      threadId: "thread",
      name: "Marketing",
      status: "running",
      notifyOnFinish: true,
      unread: true,
      activeRunId: "run-1",
    } as Bot;
    let controls!: ReturnType<typeof useBrowserNotifications>;
    function Harness({ bots, open }: { bots: Bot[]; open: string }) {
      const ref = useRef(bots);
      ref.current = bots;
      controls = useBrowserNotifications(ref, bots, open, "space");
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Harness bots={[bot]} open="agent" />));
      await act(async () =>
        controls.notifyBrowserForEvent(
          {
            id: "stream-1",
            runId: "run-1",
            threadId: "thread",
            botId: "agent",
            seq: 1,
            type,
            payload: {},
          },
          "thread",
          0,
          true,
          "Marketing",
          true,
          false,
        ),
      );
      expect(show).toHaveBeenCalledTimes(1);
      await act(async () =>
        root.render(
          <Harness
            bots={[
              {
                ...bot,
                status:
                  type === "run.failed"
                    ? "idle"
                    : type === "computer.takeover.requested"
                      ? "waiting_takeover"
                      : "waiting_input",
                runErrorId: type === "run.failed" ? "run-1" : null,
                updatedAt: "later",
              },
            ]}
            open="other"
          />,
        ),
      );
      expect(show).toHaveBeenCalledTimes(1);
      await act(async () =>
        controls.notifyBrowserForEvent(
          {
            id: "stream-2",
            runId: "run-2",
            threadId: "thread",
            botId: "agent",
            seq: 2,
            type,
            payload: {},
          },
          "thread",
          0,
          true,
          "Marketing",
          true,
          false,
        ),
      );
      expect(show).toHaveBeenCalledTimes(2);
      await act(async () =>
        controls.notifyBrowserForEvent(
          {
            id: "resume",
            runId: "run-1",
            threadId: "thread",
            botId: "agent",
            seq: 3,
            type: "run.started",
            payload: {},
          },
          "thread",
          0,
          true,
          "Marketing",
          true,
          false,
        ),
      );
      await act(async () =>
        controls.notifyBrowserForEvent(
          {
            id: "new-interruption",
            runId: "run-1",
            threadId: "thread",
            botId: "agent",
            seq: 4,
            type,
            payload: {},
          },
          "thread",
          0,
          true,
          "Marketing",
          true,
          false,
        ),
      );
      expect(show).toHaveBeenCalledTimes(3);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("does not turn mirrored user messages into synthetic bot replies", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const show = vi.fn();
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      constructor(title: string, options: NotificationOptions) {
        show(title, options);
      }
    },
  );
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  const bot = {
    id: "agent",
    threadId: "thread",
    name: "Marketing",
    status: "idle",
    unread: true,
    notifyOnFinish: true,
    preview: "Old reply",
    previewRole: "bot",
  } as Bot;
  function Harness({ bots }: { bots: Bot[] }) {
    const ref = useRef(bots);
    ref.current = bots;
    useBrowserNotifications(ref, bots, "other", "space");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Harness bots={[bot]} />));
    await act(async () =>
      root.render(
        <Harness
          bots={[
            { ...bot, preview: "My external message", previewRole: "user", updatedAt: "user" },
          ]}
        />,
      ),
    );
    expect(show).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <Harness
          bots={[{ ...bot, preview: "Agent response", previewRole: "bot", updatedAt: "bot" }]}
        />,
      ),
    );
    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.calls[0]?.[1].body).toBe("Agent response");
  } finally {
    await act(async () => root.unmount());
  }
});

it("coalesces a queued reply into the later actionable interruption for the same thread", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const show = vi.fn();
  class NotificationMock {
    static permission = "default";
    constructor(title: string, options: NotificationOptions) {
      show(title, options);
    }
  }
  vi.stubGlobal("Notification", NotificationMock);
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  const bot = {
    id: "agent",
    threadId: "thread",
    name: "Marketing",
    status: "idle",
    unread: true,
    notifyOnFinish: true,
    previewRole: "bot",
    preview: "Old reply",
  } as Bot;
  let controls!: ReturnType<typeof useBrowserNotifications>;
  function Harness({ bots }: { bots: Bot[] }) {
    const ref = useRef(bots);
    ref.current = bots;
    controls = useBrowserNotifications(ref, bots, "other", "space");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Harness bots={[bot]} />));
    await act(async () =>
      root.render(<Harness bots={[{ ...bot, preview: "New reply", updatedAt: "reply" }]} />),
    );
    await act(async () =>
      root.render(
        <Harness
          bots={[
            {
              ...bot,
              preview: "New reply",
              status: "waiting_input",
              activeRunId: "run",
              updatedAt: "question",
            },
          ]}
        />,
      ),
    );
    expect(show).not.toHaveBeenCalled();
    NotificationMock.permission = "granted";
    await act(async () => controls.flushPendingBrowserNotifications());
    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.calls[0]?.[1].body).toBe("Needs attention");
  } finally {
    await act(async () => root.unmount());
  }
});
