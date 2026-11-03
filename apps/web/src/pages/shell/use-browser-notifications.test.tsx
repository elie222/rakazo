// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { NavigateFunction } from "react-router-dom";
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
  const notices: Array<{
    title: string;
    options: NotificationOptions;
    onclick?: () => void;
  }> = [];
  const navigate = vi.fn() as unknown as NavigateFunction;
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      constructor(title: string, options: NotificationOptions) {
        notices.push(Object.assign(this, { title, options }));
      }
      close() {}
    },
  );
  Object.defineProperty(document, "visibilityState", {
    value: "hidden",
    configurable: true,
  });
  const bot = {
    id: "marketing",
    name: "Head of Marketing",
    color: "#14b8a6",
    threadId: "thread",
    status: "completed",
    unread: true,
    preview: "Old reply",
    notifyOnFinish: true,
    updatedAt: "old",
  } as Bot;
  function Harness({ bots }: { bots: Bot[] }) {
    const ref = useRef(bots);
    ref.current = bots;
    useBrowserNotifications(ref, bots, "chief", "space", navigate);
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
    notices[0]!.onclick?.();
    expect(navigate).toHaveBeenCalledWith("/app/marketing");
    await act(async () =>
      root.render(<Harness bots={[{ ...bot, preview: "Draft ready", updatedAt: "again" }]} />),
    );
    expect(notices).toHaveLength(2);
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () =>
      root.render(
        <Harness
          bots={[
            {
              ...bot,
              preview: "Draft ready",
              status: "waiting_input",
              updatedAt: "again",
            },
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
              preview: "Which tone?",
              status: "waiting_input",
              updatedAt: "ask",
            },
          ]}
        />,
      ),
    );
    expect(notices).toHaveLength(3);
    expect(notices[2]!.options.body).toBe("Needs attention");
    await act(async () =>
      root.render(
        <Harness
          bots={[
            {
              ...bot,
              preview: "Which tone?",
              status: "idle",
              updatedAt: "ask",
              runErrorId: null,
            },
          ]}
        />,
      ),
    );
    expect(notices).toHaveLength(3);
    await act(async () =>
      root.render(
        <Harness
          bots={[
            {
              ...bot,
              preview: "Which tone?",
              status: "idle",
              updatedAt: "ask",
              runErrorId: "failed-run",
            },
          ]}
        />,
      ),
    );
    expect(notices).toHaveLength(4);
    expect(notices[3]!.title).toBe("Head of Marketing failed");
  } finally {
    await act(async () => root.unmount());
  }
});
