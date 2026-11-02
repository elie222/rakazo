// @vitest-environment jsdom
import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./i18n", () => ({
  useI18n: () => ({ t: (value: string) => value }),
  t: (value: string) => value,
}));
vi.mock("./native", () => ({ useThemedStyles: () => ({}) }));
vi.mock("./activity", () => ({
  activityPreview: () => "",
  activityStatusLabel: (status: string) => status,
  formatActivityRelativeTime: () => "",
}));
vi.mock("../components/home-styles", () => ({ createHomeStyles: () => ({}) }));
vi.mock("../components/bot-avatar", () => ({
  BotAvatar: ({ identity }: { identity: string }) => <i data-agent={identity} />,
}));
vi.mock("../components/group-avatar", () => ({ GroupAvatar: () => <i /> }));
vi.mock("../components/inbox-rows", () => ({
  FALLBACK_COLOR: "orange",
  ConversationRow: ({ title, avatar }: { title: string; avatar: ReactNode }) => (
    <p>
      {avatar}
      {title}
    </p>
  ),
}));

import { ActivitySection } from "../components/inbox-activity";

it("shows attention before work and unread, with sender identities on the phone", () => {
  const markup = renderToStaticMarkup(
    createElement(ActivitySection, {
      activity: {
        active: [
          { runId: "ask", botId: "marketing", botName: "Marketing", status: "waiting_input" },
          { runId: "work", botId: "research", botName: "Research", status: "running" },
        ] as never,
        recent: [],
      },
      bots: [
        {
          id: "writer",
          name: "Writer",
          status: "idle",
          unread: true,
          preview: "Ready",
          color: "orange",
        },
      ] as never,
    }),
  );
  expect(markup.indexOf("Needs attention")).toBeLessThan(markup.indexOf("Working"));
  expect(markup.indexOf("Working")).toBeLessThan(markup.indexOf("Unread"));
  for (const identity of ["marketing", "research", "writer"])
    expect(markup).toContain(`data-agent="${identity}"`);
});

it("keeps roster-only failures and unread groups visible without run history", () => {
  const markup = renderToStaticMarkup(
    createElement(ActivitySection, {
      activity: { active: [], recent: [] },
      bots: [
        {
          id: "failed",
          name: "Failed agent",
          status: "idle",
          unread: true,
          runErrorId: "error",
          color: "orange",
        },
      ] as never,
      groups: [{ id: "group", name: "Unread team", unread: true, members: [] }] as never,
    }),
  );
  expect(markup).toContain("Needs attention");
  expect(markup).toContain("Failed agent");
  expect(markup).toContain("Unread team");
});

it("shows group approval once without a private-chat fallback", () => {
  const markup = renderToStaticMarkup(
    createElement(ActivitySection, {
      activity: {
        active: [
          {
            runId: "ask",
            botId: "marketing",
            botName: "Marketing",
            groupId: "launch",
            groupName: "Launch team",
            status: "waiting_input",
          },
        ] as never,
        recent: [],
      },
      bots: [
        {
          id: "marketing",
          name: "Marketing",
          threadId: "private",
          activeRunThreadId: "group-thread",
          status: "waiting_input",
          unread: false,
        },
      ] as never,
    }),
  );
  expect(markup).toContain("Marketing, Launch team");
  expect(markup.match(/Marketing/g)).toHaveLength(1);
});
it.each([false, true])(
  "keeps an unread completed reply in Recent while its agent or group is working: %s",
  (grouped) => {
    const markup = renderToStaticMarkup(
      createElement(ActivitySection, {
        activity: {
          active: [
            {
              runId: "work",
              botId: "worker",
              botName: "Busy agent",
              status: "running",
              groupId: grouped ? "team" : undefined,
            },
          ] as never,
          recent: [
            {
              runId: "done",
              botId: "worker",
              botName: "Finished reply",
              status: "completed",
              groupId: grouped ? "team" : undefined,
            },
          ] as never,
        },
        bots: [{ id: "worker", name: "Worker", status: "running", unread: true }] as never,
        groups: grouped ? ([{ id: "team", name: "Team", unread: true, members: [] }] as never) : [],
      }),
    );
    expect(markup).toContain("Recent");
    expect(markup).toContain("Finished reply");
  },
);

it("keeps older failures out of Needs attention when the conversation has a current failure", () => {
  const old = {
    runId: "old",
    botId: "agent",
    botName: "Old failure",
    threadId: "private",
    status: "failed",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const current = {
    ...old,
    runId: "current",
    botName: "Current failure",
    updatedAt: "2026-01-02T00:00:00Z",
  };
  const markup = renderToStaticMarkup(
    createElement(ActivitySection, {
      activity: { active: [], recent: [current, old] as never },
      bots: [
        { id: "agent", name: "Agent", unread: true, status: "idle", runErrorId: "current" },
      ] as never,
    }),
  );
  expect(markup.indexOf("Current failure")).toBeLessThan(markup.indexOf("Recent"));
  expect(markup.indexOf("Old failure")).toBeGreaterThan(markup.indexOf("Recent"));
});

it("renders roster-only waiting agents without an unread receipt and omits an empty section", () => {
  const empty = { activity: { active: [], recent: [] }, bots: [] };
  expect(renderToStaticMarkup(createElement(ActivitySection, empty))).toBe("");
  const markup = renderToStaticMarkup(
    createElement(ActivitySection, {
      ...empty,
      bots: [
        {
          id: "waiting",
          name: "Waiting agent",
          status: "waiting_input",
          unread: false,
          threadId: "private",
          activeRunThreadId: "private",
        },
      ] as never,
    }),
  );
  expect(markup).toContain("Needs attention");
  expect(markup).toContain("Waiting agent");
});
