// @vitest-environment jsdom

import type { Bot, VoiceStatus } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
  unlock: vi.fn(),
  configure: vi.fn(),
  error: vi.fn(),
  spaceId: "space-a",
}));
vi.mock("../../lib/query/rpc", () => {
  const rpc = { voice: { status: mocks.status } };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => mocks.spaceId,
  };
});
vi.mock("../../lib/calls/call-session", () => ({
  startCall: mocks.start,
  prepareCallAudio: mocks.unlock,
}));
vi.mock("@rakazo/ui-web", () => ({ toast: { error: mocks.error } }));

import { queryClient, spaceQueries } from "../../lib/query/query";
import { useCallBot } from "./use-call-bot";

const ready: VoiceStatus = {
  configured: true,
  ready: true,
  provider: "speech-a",
  voiceId: "voice-a",
  transcribe: false,
};
const queries = spaceQueries(null, "space-a");
const activeBotId = { current: "bot-a" as string | undefined };
let container: HTMLDivElement;
let root: Root;

function CallButton({ id }: { id: string }) {
  const call = useCallBot({ enabled: true, activeBotId, queries, onConfigure: mocks.configure });
  return (
    <button type="button" onClick={() => void call({ id, name: id, color: "ink" } as Bot)}>
      Call
    </button>
  );
}

async function render(id = "bot-a") {
  activeBotId.current = id;
  await act(async () => root.render(<CallButton id={id} />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  queryClient.clear();
  mocks.spaceId = "space-a";
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("waits for an in-flight bot status without sending a ready bot to Settings", async () => {
  const status = deferred<VoiceStatus>();
  mocks.status.mockReturnValue(status.promise);
  const loading = queryClient.fetchQuery(
    queries.voice.status.queryOptions({ input: { botId: "bot-a" } }),
  );
  await render();
  await act(async () => {
    container.querySelector("button")!.click();
    container.querySelector("button")!.click();
  });
  expect(mocks.unlock).toHaveBeenCalledOnce();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.configure).not.toHaveBeenCalled();
  await act(async () => {
    status.resolve(ready);
    await loading;
  });
  await vi.waitFor(() =>
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith({
      botId: "bot-a",
      botName: "bot-a",
      botColor: "ink",
      botAvatarSet: undefined,
      transcribe: false,
    }),
  );
  expect(mocks.configure).not.toHaveBeenCalled();
});

it("checks fresh readiness and only starts the bot that is still selected", async () => {
  const oldBot = deferred<VoiceStatus>();
  mocks.status.mockImplementation((input: { botId: string }) =>
    input.botId === "bot-a" ? oldBot.promise : Promise.resolve(ready),
  );
  queryClient.setQueryData(queries.voice.status.queryKey({ input: { botId: "bot-b" } }), {
    ...ready,
    ready: false,
  });
  await render();
  await act(async () => container.querySelector("button")!.click());
  await render("bot-b");
  await act(async () => container.querySelector("button")!.click());
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  expect(mocks.start.mock.calls[0]?.[0].botId).toBe("bot-b");
  await act(async () => oldBot.resolve(ready));
  expect(mocks.start).toHaveBeenCalledOnce();
  expect(mocks.configure).not.toHaveBeenCalled();
});

it("opens Voice settings only after the selected bot is confirmed not ready", async () => {
  mocks.status.mockResolvedValue({ ...ready, ready: false });
  await render();
  await act(async () => container.querySelector("button")!.click());
  await vi.waitFor(() => expect(mocks.configure).toHaveBeenCalledOnce());
  expect(mocks.start).not.toHaveBeenCalled();
});

it("releases a timed-out status read so a later Call can succeed", async () => {
  vi.useFakeTimers();
  const stalled = deferred<VoiceStatus>();
  mocks.status.mockReturnValueOnce(stalled.promise).mockResolvedValue(ready);
  await render();
  await act(async () => container.querySelector("button")!.click());
  await act(async () => vi.advanceTimersToNextTimerAsync());
  await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Voice request timed out."));
  expect(mocks.configure).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
});
