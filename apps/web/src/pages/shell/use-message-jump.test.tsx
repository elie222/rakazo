// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import { foldPeerReplies } from "@rakazo/core";
import { act, useEffect, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { NavigateFunction } from "react-router-dom";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { SpaceQueries } from "../../lib/query";
import type { createSpaceRpc } from "../../lib/rpc";
import { useMessageJump } from "./use-message-jump";
import type { ThreadState } from "./use-thread-state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const transcript = foldPeerReplies([], { includePeerReceipts: true });
const queries = {
  routines: {
    list: {
      queryOptions: () => ({ queryKey: ["routines"], queryFn: async () => [] }),
    },
  },
} as unknown as SpaceQueries;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

/** Thread reads held until the test releases them, so the chat can change first. */
function heldRpc() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rpc = {
    threads: {
      get: vi.fn(async () => {
        await held;
        return { threadId: "thread-a", messages: [], olderCursor: null };
      }),
      messages: vi.fn(async () => {
        await held;
        return { threadId: "thread-a", messages: [], olderCursor: null };
      }),
    },
  } as unknown as ReturnType<typeof createSpaceRpc>;
  return { rpc, release };
}

function Harness({
  rpc,
  locations,
  navigateRef,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  locations: string[];
  navigateRef: { current: NavigateFunction | null };
}) {
  const { kind, id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  navigateRef.current = useNavigate();
  const inGroup = kind === "group";
  const activeBotId = useRef<string | undefined>(undefined);
  activeBotId.current = inGroup ? undefined : id;
  const activeGroupId = useRef<string | undefined>(undefined);
  activeGroupId.current = inGroup ? id : undefined;
  const thread = {
    snapshot: null,
    commitSnapshot: () => undefined,
    routines: [],
    setRoutines: () => undefined,
    routinesBotId: null,
    setRoutinesBotId: () => undefined,
    expandedHistoryThread: useRef<string | null>(null),
    historyEpoch: useRef(0),
    messageScroll: useRef<HTMLDivElement>(null),
    pinnedAroundRef: useRef(null),
  } as unknown as ThreadState;
  useMessageJump({
    rpc,
    queries,
    thread,
    commitComputer: () => undefined,
    transcript,
    active: inGroup ? undefined : ({ id } as Bot),
    inGroup,
    groupId: inGroup ? id : undefined,
    activeBotId,
    activeGroupId,
    searchParams,
    setSearchParams,
    setPanel: () => undefined,
    setPanelState: () => undefined,
    editRoutine: () => undefined,
    resetRoutineTarget: () => undefined,
  });
  useEffect(() => {
    locations.push(`${location.pathname}${location.search}`);
  }, [location.pathname, location.search]);
  return null;
}

it.each([
  { name: "bot", from: "/app/bot/bot-a" },
  { name: "group", from: "/app/group/group-a" },
])("leaves the chat opened while a $name jump was loading", async ({ from }) => {
  const { rpc, release } = heldRpc();
  const locations: string[] = [];
  const navigateRef: { current: NavigateFunction | null } = { current: null };
  const container = document.createElement("div");
  root = createRoot(container);
  act(() =>
    root?.render(
      <MemoryRouter initialEntries={[`${from}?m=message-a`]}>
        <Routes>
          <Route
            path="/app/:kind/:id"
            element={<Harness rpc={rpc} locations={locations} navigateRef={navigateRef} />}
          />
        </Routes>
      </MemoryRouter>,
    ),
  );
  expect(rpc.threads.get).toHaveBeenCalledTimes(1);

  // The user opens another chat with its settings while the jump's reads are in flight.
  act(() => navigateRef.current?.("/app/bot/bot-b?settings=models"));
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(locations.at(-1)).toBe("/app/bot/bot-b?settings=models");
});

it("strips the jump from the address once it lands in the same chat", async () => {
  const { rpc, release } = heldRpc();
  const locations: string[] = [];
  const navigateRef: { current: NavigateFunction | null } = { current: null };
  const container = document.createElement("div");
  root = createRoot(container);
  act(() =>
    root?.render(
      <MemoryRouter initialEntries={["/app/bot/bot-a?m=message-a"]}>
        <Routes>
          <Route
            path="/app/:kind/:id"
            element={<Harness rpc={rpc} locations={locations} navigateRef={navigateRef} />}
          />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(locations.at(-1)).toBe("/app/bot/bot-a");
});
