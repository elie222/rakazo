// @vitest-environment jsdom

import type { VoiceStatus } from "@rakazo/contracts";
import { QueryObserver } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ status: vi.fn(), close: vi.fn() }));
vi.mock("../../lib/query/rpc", () => {
  const rpc = { voice: { status: mocks.status } };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => "space-a",
  };
});
vi.mock("../../components/ErrorBoundary", () => ({
  lazyOverlay:
    () =>
    ({
      onVoiceStatusMaybeChanged,
      onClose,
    }: {
      onVoiceStatusMaybeChanged: () => Promise<void>;
      onClose: () => void;
    }) => (
      <button type="button" onClick={() => void onVoiceStatusMaybeChanged().then(onClose)}>
        Done
      </button>
    ),
}));
vi.mock("../../lib/bootstrap", () => ({ setLabs: vi.fn() }));

import { queryClient, spaceQueries } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";
import { SettingsOverlays } from "./shell-overlays";

let container: HTMLDivElement;
let root: Root;
const unsubscribes: Array<() => void> = [];
const ready: VoiceStatus = {
  configured: true,
  ready: true,
  provider: "speech-a",
  voiceId: "voice-a",
  transcribe: true,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  queryClient.clear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  queryClient.clear();
  vi.unstubAllGlobals();
});

it.each([true, false])(
  "refreshes inherited and explicit bot readiness after Voice settings change to %s",
  async (nextReady) => {
    const queries = spaceQueries(null, "space-a");
    const targets = [{}, { botId: "inherited" }, { botId: "explicit" }];
    for (const input of targets) {
      const options = queries.voice.status.queryOptions({ input });
      queryClient.setQueryData(options.queryKey, { ...ready, ready: !nextReady });
      const observer = new QueryObserver(queryClient, { ...options, staleTime: Infinity });
      unsubscribes.push(observer.subscribe(() => undefined));
    }
    mocks.status.mockImplementation(async (input?: { botId?: string }) => ({
      ...ready,
      ready: input?.botId === "explicit" ? true : nextReady,
    }));
    await act(async () =>
      root.render(
        <SettingsOverlays
          rpc={rpc}
          queries={queries}
          overlay={{ kind: "settings", section: "voice", spaceId: null }}
          setOverlay={mocks.close}
          settingsSpace={null}
          showSettings
          spaces={[]}
          renameSpace={async () => undefined}
          removeSpace={async () => undefined}
          leftSpace={async () => undefined}
          refreshSpaces={async () => undefined}
          alive={{ current: true }}
          user={undefined}
          refetchSession={async () => undefined}
          bootstrapMe={null}
          setBootstrapMe={() => undefined}
          messagingEnabled={false}
          memoryConfig={null}
          peerConversation={null}
          setPeerConversation={() => undefined}
          active={undefined}
          peerBot={() => undefined}
        />,
      ),
    );
    await act(async () => container.querySelector("button")!.click());
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledWith(null));
    expect(
      queryClient.getQueryData(queries.voice.status.queryKey({ input: { botId: "inherited" } }))
        ?.ready,
    ).toBe(nextReady);
    expect(
      queryClient.getQueryData(queries.voice.status.queryKey({ input: { botId: "explicit" } }))
        ?.ready,
    ).toBe(true);
  },
);
