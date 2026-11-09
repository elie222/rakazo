import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  share: vi.fn(async (_args: unknown) => ({})),
}));

vi.mock("react-native", () => ({
  Share: { share: mocks.share },
}));

import { shareMessageText } from "./message-context-menu";

beforeEach(() => {
  mocks.share.mockClear();
});

describe("shareMessageText", () => {
  it("opens the system share sheet with the message text", () => {
    shareMessageText("Hello world");
    expect(mocks.share).toHaveBeenCalledExactlyOnceWith({ message: "Hello world" });
  });

  it("does nothing for blank text", () => {
    shareMessageText("   ");
    expect(mocks.share).not.toHaveBeenCalled();
  });
});
