import { expect, it } from "vitest";
import {
  accountNotificationChanges,
  accountNotificationPath,
  accountUnreadCount,
} from "./account-notifications";

const notice = {
  id: "delivery-1",
  kind: "completion" as const,
  title: "Chief",
  body: "Done",
  botId: "bot",
  threadId: "thread",
  spaceId: "space",
};
const account = {
  userId: "family",
  sessionId: "session",
  name: "Family",
  email: "family@example.test",
  image: null,
  unread: 1,
  notifications: [notice],
};

it("adds each valid account's unread chats for the app badge", () => {
  expect(accountUnreadCount([account, { ...account, userId: "work", unread: 3 }])).toBe(4);
});

it("baselines old notifications but emits a later occurrence in an already unread chat", () => {
  const seen = new Map<string, Set<string>>();
  expect(accountNotificationChanges([account], seen)).toEqual([]);
  expect(
    accountNotificationChanges(
      [{ ...account, notifications: [{ ...notice, id: "delivery-2" }] }],
      seen,
    ),
  ).toMatchObject([
    { account: { userId: "family" }, notification: { ...notice, id: "delivery-2" } },
  ]);
  expect(
    accountNotificationChanges(
      [{ ...account, notifications: [{ ...notice, id: "delivery-2" }] }],
      seen,
    ),
  ).toEqual([]);
});

it("discards removed accounts and opens group targets instead of a bot in the group", () => {
  const seen = new Map([["family", new Set(["delivery-1"])]]);
  accountNotificationChanges([], seen);
  expect(seen.size).toBe(0);
  expect(accountNotificationPath({ ...notice, groupId: "group" })).toBe("/app/g/group");
});
