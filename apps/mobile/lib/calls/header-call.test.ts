import { afterEach, describe, expect, it, vi } from "vitest";
import { onCallRequest, onShowCall, requestCall, showCall } from "./header-call";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const listen = (botId: string, listener: () => void, now?: number) => {
  cleanups.push(onCallRequest(botId, listener, now));
};

describe("header call", () => {
  it("rings only the newest chat for the bot", () => {
    const behind = vi.fn();
    const front = vi.fn();
    listen("bot-1", behind);
    listen("bot-1", front);
    requestCall("bot-1");
    expect(front).toHaveBeenCalledOnce();
    expect(behind).not.toHaveBeenCalled();
  });

  it("rings the chat behind once the newer one closes", () => {
    const behind = vi.fn();
    listen("bot-1", behind);
    const closeFront = onCallRequest("bot-1", vi.fn());
    closeFront();
    requestCall("bot-1");
    expect(behind).toHaveBeenCalledOnce();
  });

  it("keeps a tap made before the chat mounts, briefly", async () => {
    requestCall("bot-2", 1_000);
    const late = vi.fn();
    listen("bot-2", late, 5_000);
    await Promise.resolve();
    expect(late).toHaveBeenCalledOnce();

    requestCall("bot-3", 1_000);
    const tooLate = vi.fn();
    listen("bot-3", tooLate, 20_000);
    await Promise.resolve();
    expect(tooLate).not.toHaveBeenCalled();
  });

  it("does not ring another bot's chat", () => {
    const other = vi.fn();
    listen("bot-4", other);
    requestCall("bot-5");
    expect(other).not.toHaveBeenCalled();
  });

  it("asks the call screen to show itself", () => {
    const show = vi.fn();
    cleanups.push(onShowCall(show));
    showCall();
    expect(show).toHaveBeenCalledOnce();
  });
});
