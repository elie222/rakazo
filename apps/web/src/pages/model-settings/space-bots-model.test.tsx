// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const { bots, client } = vi.hoisted(() => {
  const bots = { list: vi.fn(), update: vi.fn() };
  return { bots, client: { bots } };
});

vi.mock("../../lib/space-rpc", () => ({ useSpaceRpc: () => client }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));

import { botsWithOwnModel, SpaceBotsModelNotice } from "./space-bots-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const list = [
  { id: "b1", name: "Archie", modelProvider: "anthropic", modelId: "claude-sonnet-5-5" },
  { id: "b2", name: "Scout", modelProvider: null, modelId: null },
  { id: "b3", name: "Inbox", modelProvider: "anthropic", modelId: "claude-opus-5-5" },
];

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function button(label: string) {
  return [...document.body.querySelectorAll("button")].find((node) => node.textContent === label);
}

async function render() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SpaceBotsModelNotice />);
  });
  return { host, unmount: () => act(() => root.unmount()) };
}

async function confirmSwitch() {
  await act(async () => {
    button("Use space default")!.click();
  });
  expect(document.body.textContent).toContain("Switch 2 bots to the space default?");
  expect(bots.update).not.toHaveBeenCalled();
  await act(async () => {
    button("Switch")!.click();
  });
}

it("counts only bots that pick both a provider and a model", () => {
  expect(
    botsWithOwnModel([
      { modelProvider: "anthropic", modelId: "claude-opus-5-5" },
      { modelProvider: null, modelId: null },
      { modelProvider: "openai-codex", modelId: null },
    ]),
  ).toHaveLength(1);
});

it("moves every bot with its own model onto the space default after a confirm", async () => {
  bots.list
    .mockResolvedValueOnce(list)
    .mockResolvedValue(list.map((bot) => ({ ...bot, modelProvider: null, modelId: null })));
  bots.update.mockResolvedValue({});
  const { host, unmount } = await render();
  expect(host.textContent).toContain("2 bots have their own model: Archie, Inbox");
  await confirmSwitch();
  expect(bots.update).toHaveBeenCalledTimes(2);
  expect(bots.update).toHaveBeenCalledWith({
    botId: "b1",
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
  });
  expect(bots.update).toHaveBeenCalledWith(expect.objectContaining({ botId: "b3" }));
  expect(host.textContent).toContain("2 bots now use the space default.");
  expect(host.querySelector("button")).toBeNull();
  unmount();
});

it("names the bots that did not switch and keeps them listed", async () => {
  bots.list
    .mockResolvedValueOnce(list)
    .mockResolvedValue(
      list.map((bot) => (bot.id === "b1" ? { ...bot, modelProvider: null, modelId: null } : bot)),
    );
  bots.update.mockImplementation(async ({ botId }: { botId: string }) => {
    if (botId === "b3") throw new Error("forbidden");
    return {};
  });
  const { host, unmount } = await render();
  await confirmSwitch();
  expect(host.textContent).toContain("1 bot now uses the space default.");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not switch Inbox. Try again.",
  );
  expect(host.textContent).toContain("1 bot has its own model: Inbox");
  unmount();
});

it("keeps the report on screen when the refresh after a switch fails", async () => {
  bots.list.mockResolvedValueOnce(list).mockRejectedValue(new Error("offline"));
  bots.update.mockRejectedValue(new Error("forbidden"));
  const { host, unmount } = await render();
  await confirmSwitch();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not switch Archie, Inbox. Try again.",
  );
  expect(host.textContent).toContain("2 bots have their own model: Archie, Inbox");
  unmount();
});

it("shows nothing when every bot already follows the space default", async () => {
  bots.list.mockResolvedValue([list[1]]);
  const { host, unmount } = await render();
  expect(host.textContent).toBe("");
  unmount();
});
