// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotAvatar } from "./bot-avatar.js";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

it("gives another bot a fresh Rakazo avatar, so its new loops join the shared clock", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  // Small enough to stay still, which keeps motion observers out of jsdom.
  const avatar = (identity: string, color: string) => (
    <BotAvatar avatarSet="rakazo" identity={identity} color={color} size={20} />
  );
  act(() => root.render(avatar("bot-a", "#8B5CF6")));
  const first = container.querySelector("svg");
  act(() => root.render(avatar("bot-a", "#3EC5A8")));
  expect(container.querySelector("svg")).toBe(first);
  act(() => root.render(avatar("bot-b", "#3EC5A8")));
  expect(container.querySelector("svg")).not.toBe(first);
  act(() => root.unmount());
});
