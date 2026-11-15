// @vitest-environment jsdom
import type { AppBootstrap, Bot, Group } from "@rakazo/contracts";
import { act, useLayoutEffect, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { NavigateFunction } from "react-router-dom";
import { BrowserRouter, useMatch } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import { useSpaceEpoch } from "../../lib/space-switch";
import type { RosterSignals } from "./use-browser-notifications";
import { useShellNavigation } from "./use-shell-navigation";
import { useSpaceBootstrap, useSpaceRoster } from "./use-space-roster";
import { useOpenSpaceChat } from "./use-space-switch";
import type { ThreadState } from "./use-thread-state";

const state = vi.hoisted(() => ({
  space: "personal",
  /** Whether the browser's storage accepts a newly selected space. */
  storageWritable: true,
  take: vi.fn(),
  prime: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../../lib/bootstrap", () => ({
  takeInitialBootstrap: state.take,
  primeSpaceBootstrap: state.prime,
  discardPrimedBootstrap: () => {},
}));
vi.mock("../../lib/call-session", () => ({ getSnapshot: () => null }));
vi.mock("../../lib/organizations", () => ({ leaveOrganization: async () => {} }));
vi.mock("../../lib/query", () => ({
  queryClient: { getQueryData: () => undefined, setQueryData: () => {} },
  spaceSeedKey: () => [],
  lastChatKey: () => [],
  seedOnLeave: () => undefined,
}));
vi.mock("../../lib/rpc", () => ({
  selectedSpaceId: () => state.space,
  selectSpace: (id: string) => {
    if (state.storageWritable) state.space = id;
    return state.space === id;
  },
}));
vi.mock("../../lib/tts", () => ({ speaker: { stop: () => {} } }));
vi.mock("../../lib/user-error", () => ({ errorText: () => "" }));

/** What the server holds: each space's chats, in sidebar order. */
let server: Record<string, { bots: string[]; groups: string[] }>;
let root: Root;
let shell: {
  signals: RosterSignals;
  navigate: NavigateFunction;
  openSpaceChat: (spaceId: string, path: string) => void;
};
/** Settles the load of the other space, in the order the switches asked for it. */
let spaceLoads: Array<{ finish: () => void; fail: () => void }>;

function bootstrapOf(spaceId: string, botId?: string) {
  const { bots, groups } = server[spaceId]!;
  const botSpaceId = Object.keys(server).find((id) => botId && server[id]!.bots.includes(botId));
  return {
    me: { spaceId, timezone: "UTC" },
    bots: bots.map((id) => ({ id, spaceId }) as Bot),
    groups: groups.map((id) => ({ id, spaceId }) as Group),
    botSections: [],
    archivedBots: [],
    archivedGroups: [],
    spaces: [],
    routines: [],
    ...(botSpaceId ? { botSpaceId } : {}),
  } as unknown as AppBootstrap;
}

function rpcOf(spaceId: string) {
  return {
    spaces: {
      list: async () => {
        const { bots, groups, botSections } = bootstrapOf(spaceId);
        return { current: { bots, groups, botSections }, spaces: [] };
      },
    },
  } as unknown as ReturnType<typeof createSpaceRpc>;
}

const thread = {
  snapshotRef: { current: null },
  bootstrappedThread: { current: null },
  commitSnapshot: () => {},
  setRoutines: () => {},
  setRoutinesBotId: () => {},
} as unknown as ThreadState;

/** The shell's roster, first load and space switch, wired as the shell wires them. */
function SpaceShell() {
  const groupId = useMatch("/app/g/:groupId")?.params.groupId;
  const botId = useMatch("/app/:botId")?.params.botId;
  const [shellSpaceId] = useState(state.space);
  const [rpc] = useState(() => rpcOf(shellSpaceId));
  const { navigate, navigationRevision, overlayRevision, redirectKeepingOverlay } =
    useShellNavigation();
  const roster = useSpaceRoster({
    rpc,
    seed: undefined,
    botId,
    groupId,
    navigate,
    redirectKeepingOverlay,
  });
  const openSpaceChatRef = useRef<(spaceId: string, path: string) => void>(() => {});
  const signals = useSpaceBootstrap({
    rpc,
    roster,
    thread,
    commitComputer: () => {},
    userId: "user",
    shellSpaceId,
    seed: undefined,
    startChat: undefined,
    botId,
    groupId,
    chat: undefined,
    navigate,
    redirectKeepingOverlay,
    openSpaceChat: openSpaceChatRef,
  });
  const openSpaceChat = useOpenSpaceChat({
    bootstrapSpaceId: roster.bootstrapMe?.spaceId,
    userId: "user",
    navigate,
    navigationRevision,
    overlayRevision,
    closeMobileSidebar: () => {},
    beginSpaceSwitch: roster.beginSpaceSwitch,
  });
  useLayoutEffect(() => {
    openSpaceChatRef.current = openSpaceChat;
  }, [openSpaceChat]);
  shell = { signals, navigate, openSpaceChat };
  return null;
}

function ShellPage() {
  const spaceEpoch = useSpaceEpoch();
  return <SpaceShell key={spaceEpoch} />;
}

async function open(path: string) {
  window.history.replaceState({ idx: 0 }, "", path);
  await act(async () =>
    root.render(
      <BrowserRouter useTransitions={false}>
        <ShellPage />
      </BrowserRouter>,
    ),
  );
}

/** A roster signal from the server, and the re-read it starts. */
async function rosterSignal() {
  await act(async () => {
    shell.signals.changed();
    await vi.advanceTimersByTimeAsync(50);
  });
}

async function finishLoadingSpace(index = 0, outcome: "finish" | "fail" = "finish") {
  await act(async () => {
    spaceLoads[index]![outcome]();
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  state.space = "personal";
  state.storageWritable = true;
  server = {
    personal: { bots: ["home", "errands"], groups: [] },
    work: { bots: ["sales", "support"], groups: ["standup"] },
  };
  spaceLoads = [];
  state.take.mockImplementation(async (botId?: string) => bootstrapOf(state.space, botId));
  state.prime.mockImplementation(
    (spaceId: string, botId?: string) =>
      new Promise<AppBootstrap>((resolve, reject) =>
        spaceLoads.push({
          finish: () => resolve(bootstrapOf(spaceId, botId)),
          fail: () => reject(new Error("offline")),
        }),
      ),
  );
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("a roster re-read while the shell opens a chat in another space", () => {
  it("opens a linked chat in its space when the signal came during the first load", async () => {
    let firstLoad!: (bootstrap: AppBootstrap) => void;
    state.take.mockReturnValueOnce(new Promise<AppBootstrap>((resolve) => (firstLoad = resolve)));
    await open("/app/sales?message=m1");
    // The stream opens with a signal, which is held until the first load settles.
    await rosterSignal();
    await act(async () => {
      firstLoad(bootstrapOf("personal", "sales"));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(window.location.pathname).toBe("/app/sales");
    await finishLoadingSpace();
    expect(state.space).toBe("work");
    expect(window.location.pathname + window.location.search).toBe("/app/sales?message=m1");
  });

  it("opens a linked chat in its space when the signal comes while that space loads", async () => {
    await open("/app/sales");
    expect(state.prime).toHaveBeenCalledWith("work", "sales", undefined);
    await rosterSignal();
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/sales");
    await finishLoadingSpace();
    expect(state.space).toBe("work");
    expect(window.location.pathname).toBe("/app/sales");
  });

  it("keeps a switch to another space's group when the open chat is archived meanwhile", async () => {
    await open("/app/home");
    act(() => shell.openSpaceChat("work", "/app/g/standup"));
    server.personal!.bots = ["errands"];
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/home");
    await finishLoadingSpace();
    expect(state.space).toBe("work");
    expect(window.location.pathname).toBe("/app/g/standup");
  });

  it("moves off a chat that is gone when no switch is on its way", async () => {
    await open("/app/home");
    server.personal!.bots = ["errands"];
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/errands");
    expect(state.space).toBe("personal");
  });

  it("moves off a chat that is gone after the switch was given up", async () => {
    await open("/app/sales");
    act(() => void shell.navigate("/app/home"));
    server.personal!.bots = ["errands"];
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/errands");
    await finishLoadingSpace();
    expect(state.space).toBe("personal");
    expect(window.location.pathname).toBe("/app/errands");
  });

  it("moves off a linked chat archived just after its space opened", async () => {
    await open("/app/sales");
    await finishLoadingSpace();
    expect(state.space).toBe("work");
    server.work!.bots = ["support"];
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/support");
    expect(state.space).toBe("work");
  });

  it.each(["finish", "fail"] as const)(
    "moves off a linked chat whose space cannot be selected (%s)",
    async (outcome) => {
      state.storageWritable = false;
      await open("/app/sales");
      await finishLoadingSpace(0, outcome);
      expect(state.space).toBe("personal");
      expect(window.location.pathname).toBe("/app/home");
    },
  );

  it("moves off a chat that is gone after another space could not be selected", async () => {
    await open("/app/home");
    state.storageWritable = false;
    act(() => shell.openSpaceChat("work", "/app/g/standup"));
    await finishLoadingSpace();
    expect(state.space).toBe("personal");
    expect(window.location.pathname).toBe("/app/home");
    server.personal!.bots = ["errands"];
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/errands");
  });

  it.each([
    ["a navigation to the same chat", () => void shell.navigate("/app/home")],
    ["a browser history event", () => void window.dispatchEvent(new PopStateEvent("popstate"))],
  ])("moves off a chat archived during a switch given up by %s", async (_, giveUp) => {
    await open("/app/home");
    act(() => shell.openSpaceChat("work", "/app/g/standup"));
    server.personal!.bots = ["errands"];
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/home");
    act(giveUp);
    await finishLoadingSpace();
    expect(state.space).toBe("personal");
    expect(window.location.pathname).toBe("/app/errands");
  });

  it("keeps a second switch when the first one's space finishes loading", async () => {
    server.club = { bots: ["chess"], groups: [] };
    await open("/app/home");
    act(() => shell.openSpaceChat("work", "/app/g/standup"));
    server.personal!.bots = ["errands"];
    await rosterSignal();
    act(() => shell.openSpaceChat("club", "/app/chess"));
    await finishLoadingSpace(0);
    expect(window.location.pathname).toBe("/app/home");
    await finishLoadingSpace(1);
    expect(state.space).toBe("club");
    expect(window.location.pathname).toBe("/app/chess");
  });
});
