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
