import type { Run } from "@rakazo/contracts";
import { afterEach, expect, it } from "vitest";
import {
  beginMobileAvatarFeed,
  mobileLogoAvatarActivity,
  newMobileAvatarSnapshotRequest,
  rememberMobileAvatarSnapshot,
  syncMobileAvatarSession,
} from "./logo-avatar-activity";

const run = { id: "run-a", botId: "bot-a", status: "running", trigger: "user" } as Run;
const snapshot = { threadId: "thread-a", cursor: 10, botId: "bot-a", run };
afterEach(() => mobileLogoAvatarActivity.clear());
it("uses current snapshot provenance and ignores tools before its cursor", () => {
  rememberMobileAvatarSnapshot(snapshot);
  const feed = beginMobileAvatarFeed({ botId: "bot-a" }, 10);
  expect(feed.threadId).toBe("thread-a");
  mobileLogoAvatarActivity.apply(feed.source, {
    threadId: "thread-a",
    seq: 9,
    botId: "bot-a",
    runId: "run-a",
    type: "agent.tool.called",
    payload: { name: "read_file", executionId: "old" },
  });
  expect(mobileLogoAvatarActivity.getActivity("bot-a")).toBe("working");
  mobileLogoAvatarActivity.apply(feed.source, {
    threadId: "thread-a",
    seq: 11,
    botId: "bot-a",
    runId: "run-a",
    type: "agent.tool.called",
    payload: { name: "read_file", executionId: "new" },
  });
  expect(mobileLogoAvatarActivity.getActivity("bot-a")).toBe("reading");
  rememberMobileAvatarSnapshot({ ...snapshot, cursor: 12 });
  expect(mobileLogoAvatarActivity.getActivity("bot-a")).toBe("working");
  mobileLogoAvatarActivity.resetSource(feed.source);
  expect(mobileLogoAvatarActivity.getActivity("bot-a", "running")).toBe("working");
});
it("does not restore a stale snapshot as idle on reconnect", () => {
  rememberMobileAvatarSnapshot({ ...snapshot, run: null });
  const feed = beginMobileAvatarFeed({ botId: "bot-a" }, 15);
  expect(mobileLogoAvatarActivity.getActivity("bot-a", "running")).toBe("working");
  mobileLogoAvatarActivity.resetSource(feed.source);
});
it("cannot bring an older response or a previous session into the next feed", () => {
  const older = newMobileAvatarSnapshotRequest(),
    newer = newMobileAvatarSnapshotRequest();
  rememberMobileAvatarSnapshot({ ...snapshot, cursor: 20, run: { ...run, id: "run-new" } }, newer);
  rememberMobileAvatarSnapshot(snapshot, older);
  const feed = beginMobileAvatarFeed({ botId: "bot-a" }, 20);
  mobileLogoAvatarActivity.apply(feed.source, {
    threadId: "thread-a",
    seq: 21,
    botId: "bot-a",
    runId: "run-new",
    type: "thread.progress",
    payload: { streaming: true, delta: "Reply" },
  });
  expect(mobileLogoAvatarActivity.getActivity("bot-a")).toBe("writing");
  syncMobileAvatarSession("https://example.invalid", 123);
  expect(mobileLogoAvatarActivity.getActivity("bot-a", "idle")).toBe("idle");
  expect(beginMobileAvatarFeed({ botId: "bot-a" }, 20).threadId).toBeUndefined();
});
