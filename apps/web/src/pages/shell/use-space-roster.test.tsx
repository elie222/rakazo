// @vitest-environment jsdom

import type { AppBootstrap, Bot, Group } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { ComponentType } from "react";
import { act, lazy, StrictMode, Suspense, useLayoutEffect, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { NavigateFunction } from "react-router-dom";
import { BrowserRouter, Route, Routes, useMatch } from "react-router-dom";
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
vi.mock("../../lib/call-session", () => ({
  getSnapshot: () => null,
  isLeavingSession: () => false,
}));
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
  refreshBots: () => Promise<void>;
  navigate: NavigateFunction;
  openSpaceChat: (spaceId: string, path: string) => void;
};
/** Settles the load of the other space, in the order the switches asked for it. */
let spaceLoads: Array<{ finish: () => void; fail: () => void }>;
/** While set, roster re-reads wait for it before answering. */
let rosterHeld: Promise<void> | undefined;
/** The page other than the shell that is on screen. */
let pageShown: string | undefined;

function bootstrapOf(spaceId: string, botId?: string, groupId?: string) {
  const { bots, groups } = server[spaceId]!;
  const botSpaceId = Object.keys(server).find((id) => botId && server[id]!.bots.includes(botId));
  const groupSpaceId = Object.keys(server).find(
    (id) => groupId && id !== spaceId && server[id]!.groups.includes(groupId),
  );
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
    ...(groupSpaceId ? { groupSpaceId } : {}),
  } as unknown as AppBootstrap;
}

function rpcOf(spaceId: string) {
  return {
    spaces: {
      list: async () => {
        if (rosterHeld) await rosterHeld;
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
    navigate,
    redirectKeepingOverlay,
  });
  const openSpaceChatRef = useRef<(spaceId: string, path: string) => void>(() => {});
  const signals = useSpaceBootstrap({
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
    startChatRead: () => {},
  });
  useLayoutEffect(() => {
    openSpaceChatRef.current = openSpaceChat;
  }, [openSpaceChat]);
  shell = { signals, refreshBots: roster.refreshBots, navigate, openSpaceChat };
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

/** Opens `path` as development does: the shell's effects run, are torn down, and run again. */
async function openStrict(path: string) {
  window.history.replaceState({ idx: 0 }, "", path);
  await act(async () =>
    root.render(
      <StrictMode>
        <BrowserRouter useTransitions={false}>
          <ShellPage />
        </BrowserRouter>
      </StrictMode>,
    ),
  );
}

function page(name: string): ComponentType {
  return function Page() {
    useLayoutEffect(() => {
      pageShown = name;
      return () => {
        pageShown = undefined;
      };
    }, []);
    return null;
  };
}
const OnboardingPage = page("onboarding");
const ArtifactsPage = page("artifacts");

/** A page whose code is still loading, until the returned `finish` is called. */
function stillLoading(Page: ComponentType) {
  let loaded!: () => void;
  const Loading = lazy(
    () =>
      new Promise<{ default: ComponentType }>((resolve) => {
        loaded = () => resolve({ default: Page });
      }),
  );
  return { Loading, finish: () => act(async () => loaded()) };
}

/**
 * The shell among the app's pages: the others are separate routes, whose code may still be
 * loading. No page has `/app/board` here, so the shell stands in for it, as when the board is off.
 */
async function openApp(
  path: string,
  { Onboarding = OnboardingPage, Artifacts = ArtifactsPage } = {},
) {
  window.history.replaceState({ idx: 0 }, "", path);
  await act(async () =>
    root.render(
      <BrowserRouter useTransitions={false}>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/app" element={<ShellPage />} />
            <Route path="/app/:botId" element={<ShellPage />} />
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/app/artifacts" element={<Artifacts />} />
          </Routes>
        </Suspense>
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

/** The window coming back into focus, and the re-read it starts. */
async function windowFocus() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(50);
  });
}

/** Holds roster re-reads back; the returned function lets them answer. */
function holdRoster() {
  const held = deferred();
  rosterHeld = held.promise;
  return held.resolve;
}

/** Opens `path` with its first load held back; the returned function answers it. */
async function openHoldingFirstLoad(path: string) {
  const answer = deferred<AppBootstrap>();
  state.take.mockReturnValueOnce(answer.promise);
  await open(path);
  const [botId, groupId] = state.take.mock.calls[0]!;
  return () =>
    act(async () => {
      answer.resolve(bootstrapOf("personal", botId, groupId));
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
  rosterHeld = undefined;
  pageShown = undefined;
  state.take.mockImplementation(async (botId?: string, groupId?: string) =>
    bootstrapOf(state.space, botId, groupId),
  );
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
  it.each([
    ["the signal", rosterSignal],
    ["the window's focus", windowFocus],
  ])("opens a linked chat in its space when %s came during the first load", async (_, reRead) => {
    const firstLoad = deferred<AppBootstrap>();
    state.take.mockReturnValueOnce(firstLoad.promise);
    await open("/app/sales?message=m1");
    // The stream opens with a signal; like focus, it is held until the first load settles.
    await reRead();
    await act(async () => {
      firstLoad.resolve(bootstrapOf("personal", "sales"));
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

describe("a first load that sends an empty space to onboarding", () => {
  let answerFirstLoad: () => void;
  beforeEach(() => {
    server.work = { bots: [], groups: [] };
    state.space = "work";
    state.take.mockReturnValueOnce(
      new Promise<AppBootstrap>((resolve) => {
        answerFirstLoad = () => resolve(bootstrapOf("work"));
      }),
    );
  });

  it("goes to onboarding when the window was focused during the first load", async () => {
    await openApp("/app");
    await windowFocus();
    await act(async () => {
      answerFirstLoad();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(window.location.pathname).toBe("/onboarding");
    expect(pageShown).toBe("onboarding");
  });

  it("stays on onboarding when the roster is re-read while onboarding's code loads", async () => {
    const onboarding = stillLoading(OnboardingPage);
    await openApp("/app", { Onboarding: onboarding.Loading });
    // The stream opens with a signal, which is held until the first load settles.
    await rosterSignal();
    await act(async () => {
      answerFirstLoad();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(window.location.pathname).toBe("/onboarding");
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(window.location.pathname).toBe("/onboarding");
    await onboarding.finish();
    expect(window.location.pathname).toBe("/onboarding");
    expect(pageShown).toBe("onboarding");
  });

  it("stays on onboarding when a re-read answers before the shell has gone", async () => {
    await openApp("/app");
    const answerRoster = holdRoster();
    // An action in the shell re-reads at once; focus and signals wait for the first load.
    act(() => void shell.refreshBots());
    // Both answers arrive before React has rendered the page the first one moved to.
    await act(async () => {
      answerFirstLoad();
      answerRoster();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(window.location.pathname).toBe("/onboarding");
    expect(pageShown).toBe("onboarding");
  });
});

describe("another page under /app whose code is still loading", () => {
  it("stays on the page when the chat the shell had open is gone", async () => {
    const artifacts = stillLoading(ArtifactsPage);
    await openApp("/app/home", { Artifacts: artifacts.Loading });
    act(() => void shell.navigate("/app/artifacts"));
    server.personal!.bots = ["errands"];
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/artifacts");
    await artifacts.finish();
    expect(window.location.pathname).toBe("/app/artifacts");
    expect(pageShown).toBe("artifacts");
  });

  it("stays on the page when the first load answers after the user opened it", async () => {
    let answerFirstLoad!: () => void;
    state.take.mockReturnValueOnce(
      new Promise<AppBootstrap>((resolve) => {
        answerFirstLoad = () => resolve(bootstrapOf("personal", "home"));
      }),
    );
    const artifacts = stillLoading(ArtifactsPage);
    await openApp("/app/home", { Artifacts: artifacts.Loading });
    act(() => void shell.navigate("/app/artifacts"));
    await act(async () => {
      answerFirstLoad();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(window.location.pathname).toBe("/app/artifacts");
    await artifacts.finish();
    expect(window.location.pathname).toBe("/app/artifacts");
    expect(pageShown).toBe("artifacts");
  });

  it("moves off a path the shell stands in for", async () => {
    await openApp("/app/board");
    expect(window.location.pathname).toBe("/app/home");
    act(() => void shell.navigate("/app/board"));
    expect(window.location.pathname).toBe("/app/board");
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/home");
  });
});

describe("a re-read that answers as the user opens another chat", () => {
  it("stays on the chat just opened when the one before it is gone", async () => {
    server.personal!.bots = ["home", "errands", "chores"];
    await open("/app/home");
    const answerRoster = holdRoster();
    await rosterSignal();
    server.personal!.bots = ["errands", "chores"];
    // The answer arrives before React has rendered the chat the user moved to.
    await act(async () => {
      void shell.navigate("/app/chores");
      answerRoster();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(window.location.pathname).toBe("/app/chores");
  });
});

describe("a first load that answers after the user moved on", () => {
  it.each([
    ["a group", "/app/g/standup"],
    ["a bot", "/app/sales"],
    ["a group that is gone", "/app/g/retired"],
    ["a bot that is gone", "/app/retired"],
  ])("stays on the chat opened while a link to %s was loading", async (_, link) => {
    const answerFirstLoad = await openHoldingFirstLoad(link);
    act(() => void shell.navigate("/app/errands"));
    await answerFirstLoad();
    expect(state.prime).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/app/errands");
    await rosterSignal();
    expect(state.space).toBe("personal");
    expect(window.location.pathname).toBe("/app/errands");
  });

  it.each([
    ["a group", "/app/g/standup"],
    ["a bot", "/app/sales"],
  ])("opens a link to %s that the user came back to", async (_, link) => {
    const answerFirstLoad = await openHoldingFirstLoad(link);
    act(() => void shell.navigate("/app/errands"));
    act(() => void shell.navigate(link));
    await answerFirstLoad();
    await finishLoadingSpace();
    expect(state.space).toBe("work");
    expect(window.location.pathname).toBe(link);
  });

  it.each([
    ["a group in another space", "/app/g/standup"],
    ["a bot in another space", "/app/sales"],
    ["a group that is gone", "/app/g/retired"],
    ["a bot that is gone", "/app/retired"],
  ])("keeps a switch the user started while a link to %s was loading", async (_, link) => {
    server.club = { bots: ["chess"], groups: [] };
    const answerFirstLoad = await openHoldingFirstLoad(link);
    act(() => shell.openSpaceChat("club", "/app/chess"));
    await answerFirstLoad();
    expect(state.prime).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe(link);
    await finishLoadingSpace();
    expect(state.space).toBe("club");
    expect(window.location.pathname).toBe("/app/chess");
  });
});

describe("a link to a group chat in another space", () => {
  it("opens the group in its space, keeping the link's query", async () => {
    await open("/app/g/standup?message=m1");
    expect(state.prime).toHaveBeenCalledWith("work", undefined, undefined);
    expect(window.location.pathname).toBe("/app/g/standup");
    await finishLoadingSpace();
    expect(state.space).toBe("work");
    expect(window.location.pathname + window.location.search).toBe("/app/g/standup?message=m1");
  });

  it("opens the group in its space when the signal came during the first load", async () => {
    const firstLoad = deferred<AppBootstrap>();
    state.take.mockReturnValueOnce(firstLoad.promise);
    await open("/app/g/standup");
    await rosterSignal();
    await act(async () => {
      firstLoad.resolve(bootstrapOf("personal", undefined, "standup"));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(window.location.pathname).toBe("/app/g/standup");
    await finishLoadingSpace();
    expect(state.space).toBe("work");
    expect(window.location.pathname).toBe("/app/g/standup");
  });

  it("opens the group in its space when a discarded first load answers before the kept one", async () => {
    const kept = deferred<AppBootstrap>();
    state.take
      .mockImplementationOnce(async (botId?: string, groupId?: string) =>
        bootstrapOf("personal", botId, groupId),
      )
      .mockReturnValueOnce(kept.promise);
    await openStrict("/app/g/standup");
    expect(state.take).toHaveBeenCalledTimes(2);
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/g/standup");
    await act(async () => {
      kept.resolve(bootstrapOf("personal", undefined, "standup"));
      await vi.advanceTimersByTimeAsync(50);
    });
    await finishLoadingSpace();
    expect(state.space).toBe("work");
    expect(window.location.pathname).toBe("/app/g/standup");
  });

  it("opens the group in its space when the signal comes while that space loads", async () => {
    await open("/app/g/standup");
    await rosterSignal();
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/g/standup");
    await finishLoadingSpace();
    expect(state.space).toBe("work");
    expect(window.location.pathname).toBe("/app/g/standup");
  });

  it("moves off the group after the switch was given up", async () => {
    await open("/app/g/standup");
    act(() => void shell.navigate("/app/g/retired"));
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/home");
    await finishLoadingSpace();
    expect(state.space).toBe("personal");
    expect(window.location.pathname).toBe("/app/home");
  });

  it("moves off a group that no space of the user's has", async () => {
    await open("/app/g/retired");
    expect(state.prime).not.toHaveBeenCalled();
    expect(state.space).toBe("personal");
    expect(window.location.pathname).toBe("/app/home");
  });

  it("moves off the group when it is archived just after its space opened", async () => {
    await open("/app/g/standup");
    await finishLoadingSpace();
    expect(state.space).toBe("work");
    server.work!.groups = [];
    await rosterSignal();
    expect(window.location.pathname).toBe("/app/sales");
    expect(state.space).toBe("work");
  });

  it.each(["finish", "fail"] as const)(
    "moves off the group when its space cannot be selected (%s)",
    async (outcome) => {
      state.storageWritable = false;
      await open("/app/g/standup");
      await finishLoadingSpace(0, outcome);
      expect(state.space).toBe("personal");
      expect(window.location.pathname).toBe("/app/home");
    },
  );
});
