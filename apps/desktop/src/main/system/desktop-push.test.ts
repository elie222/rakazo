import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { chatFromLaunch, createDesktopPush, desktopPushEnvironment } from "./desktop-push.js";

function setup(register: () => Promise<string>, enabled = true) {
  const frame = { url: "https://app.example.com/app/bot" };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: () => false,
  }) as unknown as WebContents;
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent;
  const target = { webContents: contents, url: "https://app.example.com" };
  const push = createDesktopPush({ enabled, getTarget: () => target, register });
  return { event, push };
}

describe("desktop push", () => {
  it("reads the chat a notification click launched the app for", () => {
    expect(
      chatFromLaunch({
        actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier",
        userInfo: { aps: {}, botId: "bot-1", threadId: "thread-1", spaceId: "space-1" },
      }),
    ).toEqual({ botId: "bot-1", threadId: "thread-1", spaceId: "space-1" });
    expect(chatFromLaunch({})).toBeNull();
    expect(chatFromLaunch({ userInfo: { botId: "bot-1" } })).toBeNull();
    expect(chatFromLaunch(undefined)).toBeNull();
  });

  it("hands the opened chat to the app's page once", () => {
    const { event, push } = setup(async () => "token");
    push.launched({ userInfo: { botId: "bot-1", threadId: "thread-1", groupId: "group-1" } });
    expect(push.takeOpened({ ...event, senderFrame: null })).toBeNull();
    expect(push.takeOpened(event)).toEqual({
      botId: "bot-1",
      threadId: "thread-1",
      groupId: "group-1",
    });
    expect(push.takeOpened(event)).toBeNull();
  });

  it("registers once, retries after a refusal, and answers nothing to other frames", async () => {
    const register = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("no entitlement"))
      .mockResolvedValue("token");
    const { event, push } = setup(register);
    expect(await push.token({ ...event, sender: {} as WebContents })).toBeNull();
    expect(await push.token(event)).toBeNull();
    expect(await push.token(event)).toBe("token");
    expect(await push.token(event)).toBe("token");
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("never asks macOS for a token in a build without push", async () => {
    const register = vi.fn(async () => "token");
    const { event, push } = setup(register, false);
    expect(await push.token(event)).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it("reads the build's push environment and nothing else", () => {
    expect(desktopPushEnvironment("production")).toBe("production");
    expect(desktopPushEnvironment("development")).toBe("development");
    expect(desktopPushEnvironment("1")).toBeUndefined();
    expect(desktopPushEnvironment(undefined)).toBeUndefined();
  });
});
