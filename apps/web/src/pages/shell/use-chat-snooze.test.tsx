// @vitest-environment jsdom
import type { Bot, Group, Space } from "@rakazo/contracts";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import type { SnoozeChat, ToggleChat } from "./use-chat-snooze";
import { useChatHide, useChatMute, useChatSnooze } from "./use-chat-snooze";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({ toast }));
vi.mock("../../lib/rpc", () => ({ rpcForSpace: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("puts a chat back to what the server saved when a snooze and its quick undo both fail", async () => {
  const calls: Array<{ reject: (error: Error) => void }> = [];
  const rpc = {
    threads: {
      snooze: () => new Promise((_resolve, reject) => calls.push({ reject })),
    },
  } as unknown as ReturnType<typeof createSpaceRpc>;
  const refreshBots = vi.fn(async () => undefined);
  let state: { bots: Bot[]; snooze: SnoozeChat } | undefined;
  function Harness() {
    const [bots, setBots] = useState([{ id: "bot", spaceId: "space", snoozedUntil: null } as Bot]);
    const [, setGroups] = useState<Group[]>([]);
    const [, setSpaces] = useState<Space[]>([]);
    const snooze = useChatSnooze({
      rpc,
      openSpaceId: "space",
      setBots,
      setGroups,
      setSpaces,
      refreshBots,
    });
    state = { bots, snooze };
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
  const chat = { kind: "bot" as const, id: "bot", spaceId: "space" };

  const tomorrow = "2026-11-08T09:00:00.000Z";
  await act(async () => state!.snooze({ ...chat, snoozedUntil: null }, tomorrow));
  await act(async () => state!.snooze({ ...chat, snoozedUntil: tomorrow }, null));
  expect(state!.bots[0]!.snoozedUntil).toBeNull();

  // The snooze fails; the undo, sent after it, fails too.
  await act(async () => calls[0]!.reject(new Error("offline")));
  await act(async () => calls[1]!.reject(new Error("offline")));

  expect(state!.bots[0]!.snoozedUntil).toBeNull();
  expect(toast.error).toHaveBeenCalledTimes(1);
  expect(refreshBots).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it("mutes a group and hides a bot at once, and puts a failed hide back", async () => {
  const mute = vi.fn(async () => ({ ok: true }));
  let rejectHide: (error: Error) => void = () => undefined;
  const hide = vi.fn(() => new Promise((_resolve, reject) => (rejectHide = reject)));
  const rpc = { threads: { mute, hide } } as unknown as ReturnType<typeof createSpaceRpc>;
  const refreshBots = vi.fn(async () => undefined);
  let state: { bots: Bot[]; groups: Group[]; mute: ToggleChat; hide: ToggleChat } | undefined;
  function Harness() {
    const [bots, setBots] = useState([{ id: "bot", spaceId: "space", hidden: false } as Bot]);
    const [groups, setGroups] = useState([{ id: "crew", spaceId: "space", muted: false } as Group]);
    const [, setSpaces] = useState<Space[]>([]);
    const deps = { rpc, openSpaceId: "space", setBots, setGroups, setSpaces, refreshBots };
    state = { bots, groups, mute: useChatMute(deps), hide: useChatHide(deps) };
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));

  await act(async () => state!.mute({ kind: "group", id: "crew", spaceId: "space" }, true));
  expect(mute).toHaveBeenCalledWith({ groupId: "crew", muted: true });
  expect(state!.groups[0]!.muted).toBe(true);

  await act(async () =>
    state!.hide({ kind: "bot", id: "bot", spaceId: "space", hidden: false }, true),
  );
  expect(hide).toHaveBeenCalledWith({ botId: "bot", hidden: true });
  expect(state!.bots[0]!.hidden).toBe(true);
  await act(async () => rejectHide(new Error("offline")));
  expect(state!.bots[0]!.hidden).toBe(false);
  expect(toast.error).toHaveBeenCalled();
  await act(async () => root.unmount());
});
