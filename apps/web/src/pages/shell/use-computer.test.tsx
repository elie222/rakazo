// @vitest-environment jsdom

import { COMPUTER_ALLOWANCE_USED_ERROR } from "@rakazo/contracts";
import { SCREEN_RECONNECT_STABLE_MS } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCREEN_FRAME_LOAD_TIMEOUT_MS, screenFrames } from "../../lib/computer-screen";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Spinner: () => null,
}));
vi.mock("../../components/ComputerMaintenanceActions", () => ({
  ComputerMaintenanceActions: () => null,
}));

import type { ComputerState } from "./use-computer";
import { useComputerControls, useComputerState } from "./use-computer";

let container: HTMLDivElement;
let root: Root;
let state: ComputerState;
let codes = 0;
let screenUrlFactory: () => string = () =>
  `wuying://desktop?desktop_id=ecd-1&region_id=cn-hangzhou&auth_code=code-${++codes}&view_only=true`;
const screenUrl = vi.fn(async () => ({ url: screenUrlFactory() }));

/** The hook with the frame the panel draws: gone while an error replaces the screen. */
function Harness() {
  state = useComputerState({
    rpc: { computer: { screenUrl } } as never,
    panel: "computer",
    activeId: "bot-1",
    activeBotId: { current: "bot-1" },
  });
  if (!state.screenUrl || state.screenLoadError) return null;
  // Drawn as the panel and overlay draw it: a held predecessor first, then the live frame.
  return screenFrames(state.screenFrameKey, state.screenUrl, state.heldScreen).map((frame) => (
    <iframe
      key={frame.key}
      ref={frame.held ? undefined : state.setScreenFrame}
      data-src={frame.url}
      aria-hidden={frame.held || undefined}
      title="screen"
    />
  ));
}

const code = () => /auth_code=([^&]+)/.exec(state.screenUrl ?? "")?.[1] ?? null;

async function read() {
  await act(async () => {
    await state.refreshComputerScreen("bot-1");
  });
}

async function report(rakazoScreen: string) {
  const frame = container.querySelector("iframe");
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { rakazoScreen }, source: frame?.contentWindow }),
    );
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  codes = 0;
  screenUrlFactory = () =>
    `wuying://desktop?desktop_id=ecd-1&region_id=cn-hangzhou&auth_code=code-${++codes}&view_only=true`;
  screenUrl.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("shows a Wuying screen's failure and waits for Retry rather than spend another code", async () => {
  await read();
  expect(code()).toBe("code-1");
  await report("connecting");
  await report("failed");
  expect(state.screenLoadError).toBe("Could not connect to the computer screen");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  await read();
  expect(state.screenUrl).toBeNull();
  expect(container.querySelector("iframe")).toBeNull();
});

it("keeps a live Wuying frame's code, and reconnects every drop with a fresh code", async () => {
  await read();
  await report("connected");
  await read();
  expect(code()).toBe("code-1");
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(code()).toBe("code-3");
  await report("connected");
  // The connection stays up; the next drop is a new restart, with the first delay again.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SCREEN_RECONNECT_STABLE_MS);
  });
  await report("disconnected");
  expect(state.screenLoadError).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(code()).toBe("code-4");
  expect(screenUrl).toHaveBeenCalledTimes(4);
});

it("shows a Wuying screen's error only after its reloads stop connecting", async () => {
  await read();
  await report("connected");
  await report("disconnected");
  // The reload races the restart and never connects; each failure loads a fresh code, waiting
  // longer each time, until the retries run out and the error waits for Retry.
  for (const wait of [1_000, 2_000, 4_000]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(wait);
    });
    expect(state.screenLoadError).toBeNull();
    await report("failed");
  }
  expect(state.screenLoadError).toBe("Could not connect to the computer screen");
});

it("never caches a Wuying login code", async () => {
  await read();
  expect(state.computerCacheRef.current.get("bot-1")?.screenUrl).toBeNull();
});

it("reconnects a proxied screen whose reload raced a restart, without the error", async () => {
  screenUrlFactory = () => "/novnc/session/view/1.restart/vnc.html";
  await read();
  await report("connected");
  // The screen restarts under the viewer: the proxy closes the socket, the app reloads the
  // page, and the screen server refuses that reload's connection once.
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await report("failed");
  expect(state.screenLoadError).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  await report("connected");
  expect(state.screenLoadError).toBeNull();
  expect(container.querySelector("iframe")).not.toBeNull();
});

it("shows a proxied screen's error only after its reloads stop connecting", async () => {
  screenUrlFactory = () => "/novnc/session/view/1.stuck/vnc.html";
  await read();
  await report("connected");
  await report("disconnected");
  for (const wait of [1_000, 2_000, 4_000]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(wait);
    });
    expect(state.screenLoadError).toBeNull();
    await report("failed");
  }
  expect(state.screenLoadError).toBe("Could not connect to the computer screen");
  expect(container.querySelector("iframe")).toBeNull();
});

it("keeps one reconnect while its screen read is still pending", async () => {
  await read();
  await report("connected");
  // The drop's screen read answers slowly; the dying page reports the same drop again, and
  // that second read would fail.
  let release: (() => void) | undefined;
  screenUrl.mockImplementationOnce(
    () =>
      new Promise<{ url: string }>((resolve) => {
        release = () => resolve({ url: screenUrlFactory() });
      }),
  );
  screenUrl.mockImplementationOnce(async () => {
    throw new Error("screen read failed");
  });
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await report("failed");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screenUrl).toHaveBeenCalledTimes(2);
  expect(state.screenLoadError).toBeNull();
  // The one pending read completes with a fresh code, and the screen keeps it.
  await act(async () => {
    release?.();
  });
  expect(state.screenLoadError).toBeNull();
  expect(code()).toBe("code-2");
});

it("reconnects again after a reconnection cancels a queued retry", async () => {
  await read();
  await report("connected");
  await report("disconnected");
  // The SDK rejoined by itself, so the queued retry is cancelled without a read.
  await report("connected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screenUrl).toHaveBeenCalledTimes(1);
  // A later drop still reconnects rather than waiting in a stuck hold.
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(screenUrl).toHaveBeenCalledTimes(2);
  expect(code()).toBe("code-2");
  expect(state.screenLoadError).toBeNull();
});

it("reconnects again after its read ends on an already rejoined screen", async () => {
  await read();
  await report("connected");
  let release: (() => void) | undefined;
  screenUrl.mockImplementationOnce(
    () =>
      new Promise<{ url: string }>((resolve) => {
        release = () => resolve({ url: screenUrlFactory() });
      }),
  );
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  // The provider rejoined the same session while the read was out; the completed read
  // keeps the live URL, so nothing re-runs the effect.
  await report("connected");
  await act(async () => {
    release?.();
  });
  expect(code()).toBe("code-1");
  // A later drop still reconnects.
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(screenUrl).toHaveBeenCalledTimes(3);
  expect(code()).toBe("code-3");
  expect(state.screenLoadError).toBeNull();
});

it("shows the error when a reconnect read never settles", async () => {
  await read();
  await report("connected");
  let settle: ((value: { url: string }) => void) | undefined;
  screenUrl.mockImplementationOnce(
    () =>
      new Promise<{ url: string }>((resolve) => {
        settle = resolve;
      }),
  );
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(state.screenLoadError).toBeNull();
  // The read gets the same silence budget a framed screen has; past it the dropped screen
  // shows the error with Retry instead of waiting forever.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SCREEN_FRAME_LOAD_TIMEOUT_MS);
  });
  expect(state.screenLoadError).toBe("Could not connect to the computer screen");
  // An answer that arrives after the deadline does not commit: the screen keeps waiting
  // for Retry.
  await act(async () => {
    settle?.({ url: screenUrlFactory() });
  });
  expect(code()).toBeNull();
  expect(state.screenLoadError).toBe("Could not connect to the computer screen");
});

it("leaves a reconnected screen showing when its hung read runs out of time", async () => {
  await read();
  await report("connected");
  screenUrl.mockImplementationOnce(() => new Promise<{ url: string }>(() => undefined));
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  // The provider rejoined while the read hung; the screen keeps showing, and the deadline
  // releases the hold without an error.
  await report("connected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SCREEN_FRAME_LOAD_TIMEOUT_MS);
  });
  expect(state.screenLoadError).toBeNull();
  // A later drop reconnects again.
  screenUrl.mockImplementationOnce(async () => ({ url: screenUrlFactory() }));
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screenUrl).toHaveBeenCalledTimes(3);
  expect(code()).toBe("code-2");
  expect(state.screenLoadError).toBeNull();
});

it("keeps a newer read's answer when the hung reconnect read runs out of time", async () => {
  await read();
  await report("connected");
  screenUrl.mockImplementationOnce(() => new Promise<{ url: string }>(() => undefined));
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await report("connected");
  // A newer read, such as a takeover's, starts just before the hung read's deadline and is
  // itself slow.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14_000);
  });
  const takeoverUrl = `wuying://desktop?desktop_id=ecd-1&region_id=cn-hangzhou&auth_code=takeover&view_only=false`;
  let answerB: ((value: { url: string }) => void) | undefined;
  screenUrl.mockImplementationOnce(
    () =>
      new Promise<{ url: string }>((resolve) => {
        answerB = (value) => resolve(value);
      }),
  );
  await act(async () => {
    void state.refreshComputerScreen("bot-1");
  });
  // The hung read's deadline fires while the newer read is still out.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await act(async () => {
    answerB?.({ url: takeoverUrl });
  });
  expect(state.screenUrl).toBe(takeoverUrl);
  expect(state.screenLoadError).toBeNull();
});

const proxied = (policy: "view" | "control", token: string) =>
  `/novnc/session/${policy}/9999999999999.${token}/embed.html`;

async function reportFrom(frame: HTMLIFrameElement, rakazoScreen: string) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { rakazoScreen }, source: frame.contentWindow }),
    );
  });
}

it("keeps the replaced screen over its successor until that one connects", async () => {
  screenUrlFactory = () => proxied("view", "v1");
  await read();
  const viewFrame = container.querySelector("iframe")!;
  screenUrlFactory = () => proxied("control", "c1");
  await read();
  let frames = [...container.querySelectorAll("iframe")];
  expect(frames).toHaveLength(2);
  // The same element stays, so its page does not reload.
  expect(frames[0]).toBe(viewFrame);
  expect(frames[0]!.getAttribute("aria-hidden")).toBe("true");
  expect(frames[1]!.dataset.src).toContain("/control/");
  await reportFrom(frames[1]!, "connecting");
  expect(container.querySelectorAll("iframe")).toHaveLength(2);
  await reportFrom(frames[1]!, "connected");
  frames = [...container.querySelectorAll("iframe")];
  expect(frames).toHaveLength(1);
  expect(frames[0]!.dataset.src).toContain("/control/");
});

it("shows the remembered view at once on release and returns to control if it fails", async () => {
  const pending = { reject: (_error: Error) => {} };
  const release = vi.fn(
    () =>
      new Promise<never>((_resolve, reject) => {
        pending.reject = reject;
      }),
  );
  let controls!: ReturnType<typeof useComputerControls>;
  function Controls() {
    controls = useComputerControls({
      rpc: { computer: { release, screenUrl } } as never,
      state,
      panel: "computer",
      active: undefined,
      bots: [],
      botsRef: { current: [] },
      activeBotId: { current: "bot-1" },
      activeGroupId: { current: undefined },
      runStatus: undefined,
      recording: false,
      sandboxProvider: undefined,
      refreshThread: vi.fn(async () => ({}) as never),
      refreshGroupThread: vi.fn(),
      onUpgrade: vi.fn(),
    });
    return null;
  }
  await act(async () =>
    root.render(
      <>
        <Harness />
        <Controls />
      </>,
    ),
  );
  screenUrlFactory = () => proxied("view", "v1");
  await read();
  screenUrlFactory = () => proxied("control", "c1");
  await read();
  let released!: Promise<boolean>;
  await act(async () => {
    released = controls.releaseComputer();
  });
  expect(release).toHaveBeenCalled();
  expect(state.screenUrl).toBe(proxied("view", "v1"));
  await act(async () => {
    pending.reject(new Error("offline"));
    await released;
  });
  expect(state.screenUrl).toBe(proxied("control", "c1"));
});

it("closes the computer view on Escape, but not on the Escape that ends an IME composition", async () => {
  function Controls() {
    state = useComputerState({
      rpc: {} as never,
      panel: null,
      activeId: undefined,
      activeBotId: { current: undefined },
    });
    useComputerControls({
      rpc: {} as never,
      state,
      panel: null,
      active: undefined,
      bots: [],
      botsRef: { current: [] },
      activeBotId: { current: undefined },
      activeGroupId: { current: undefined },
      runStatus: undefined,
      recording: false,
      sandboxProvider: undefined,
      refreshThread: vi.fn(),
      refreshGroupThread: vi.fn(),
      onUpgrade: vi.fn(),
    });
    // Stands in for the view's "Teach a task" goal box, whose popover lets a composing Escape bubble.
    return <textarea aria-label="Goal" />;
  }
  await act(async () => root.render(<Controls />));
  await act(async () => state.setComputerOpen(true));
  const goal = container.querySelector("textarea")!;
  const press = (init: KeyboardEventInit = {}) =>
    act(async () => {
      goal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...init }));
    });
  await press({ isComposing: true });
  await press({ keyCode: 229 });
  expect(state.computerOpen).toBe(true);
  await press();
  expect(state.computerOpen).toBe(false);
});

it("offers Upgrade instead of a retry once the computer hours are spent", async () => {
  const onUpgrade = vi.fn();
  function Controls() {
    state = useComputerState({
      rpc: {} as never,
      panel: null,
      activeId: undefined,
      activeBotId: { current: undefined },
    });
    const controls = useComputerControls({
      rpc: {} as never,
      state,
      panel: null,
      active: undefined,
      bots: [],
      botsRef: { current: [] },
      activeBotId: { current: undefined },
      activeGroupId: { current: undefined },
      runStatus: undefined,
      recording: false,
      sandboxProvider: undefined,
      refreshThread: vi.fn(),
      refreshGroupThread: vi.fn(),
      onUpgrade,
    });
    return <>{controls.computerScreenError}</>;
  }
  await act(async () => root.render(<Controls />));
  await act(async () => state.setComputerError(COMPUTER_ALLOWANCE_USED_ERROR));
  const buttons = [...container.querySelectorAll("button")].map((button) => button.textContent);
  expect(buttons).toEqual(["Upgrade"]);
  await act(async () => container.querySelector("button")!.click());
  expect(onUpgrade).toHaveBeenCalledOnce();
  await act(async () => state.commitComputer({ state: "running", kind: "browser" } as never));
  expect(container.textContent).not.toContain("Upgrade");
});

it("asks whenever the status says the computer is free, and hands control back on close", async () => {
  const takeover = vi.fn(
    async (_: unknown): Promise<{ leaseId: string; expiresAt: string } | null> => null,
  );
  const release = vi.fn(async () => ({ ok: true as const }));
  const bot = { id: "bot-1", name: "Ada" } as never;
  let runStatus: "running" | undefined = "running";
  function Controls() {
    state = useComputerState({
      rpc: { computer: { screenUrl } } as never,
      panel: null,
      activeId: "bot-1",
      activeBotId: { current: "bot-1" },
    });
    useComputerControls({
      rpc: {
        computer: {
          boot: vi.fn(async () => null),
          takeover,
          release,
          screenUrl,
          status: vi.fn(async () => state.computerRef.current),
          heartbeat: vi.fn(async () => ({ ok: true as const })),
        },
      } as never,
      state,
      panel: null,
      active: bot,
      bots: [bot],
      botsRef: { current: [bot] },
      activeBotId: { current: "bot-1" },
      activeGroupId: { current: undefined },
      runStatus,
      recording: false,
      sandboxProvider: undefined,
      refreshThread: vi.fn(async () => ({}) as never),
      refreshGroupThread: vi.fn(),
      onUpgrade: vi.fn(),
    });
    return null;
  }
  const free = {
    botId: "bot-1",
    mode: "team",
    kind: "boat",
    state: "running",
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: true,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
  } as const;
  const held = { ...free, controlHolder: "user", controlBotId: "bot-1" } as const;
  await act(async () => root.render(<Controls />));
  await act(async () => state.commitComputer({ ...free, busyBotName: "Ada" }));
  await act(async () => state.setComputerOpen(true));
  // The bot's own run keeps the screen.
  expect(takeover).not.toHaveBeenCalled();

  runStatus = undefined;
  await act(async () => state.commitComputer({ ...free }));
  expect(takeover).toHaveBeenCalledWith({ botId: "bot-1", ifAvailable: true });
  // A refused ask changes nothing, so it waits for the next status.
  expect(takeover).toHaveBeenCalledOnce();

  takeover.mockResolvedValue({ leaseId: "lease-1", expiresAt: "" });
  await act(async () => state.commitComputer({ ...free }));
  expect(takeover).toHaveBeenCalledTimes(2);
  await act(async () => state.commitComputer({ ...held }));
  // The lease lapsed while the window stayed open: it asks again.
  await act(async () => state.commitComputer({ ...free }));
  expect(takeover).toHaveBeenCalledTimes(3);

  // A failed ask shows its error until the next status, which asks again.
  takeover.mockRejectedValueOnce(new Error("offline"));
  await act(async () => state.commitComputer({ ...free }));
  expect(takeover).toHaveBeenCalledTimes(4);
  expect(state.computerError).toBe("offline");
  await act(async () => state.commitComputer({ ...free }));
  expect(state.computerError).toBeNull();
  expect(takeover).toHaveBeenCalledTimes(5);
  // Retry clears the error, which asks again on the same status.
  takeover.mockRejectedValueOnce(new Error("offline"));
  await act(async () => state.commitComputer({ ...free }));
  expect(takeover).toHaveBeenCalledTimes(6);
  await act(async () => state.setComputerError(null));
  expect(takeover).toHaveBeenCalledTimes(7);

  await act(async () => state.commitComputer({ ...held }));
  await act(async () => state.setComputerOpen(false));
  expect(release).toHaveBeenCalledWith({ botId: "bot-1" });
});

it("hands back on close only control this window took, even after a failed I’m done", async () => {
  const release = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ ok: true });
  const takeover = vi.fn(async () => ({ leaseId: "lease-1", expiresAt: "" }));
  const bot = { id: "bot-1", name: "Ada" } as never;
  let controls!: ReturnType<typeof useComputerControls>;
  function Controls() {
    state = useComputerState({
      rpc: { computer: { screenUrl } } as never,
      panel: null,
      activeId: "bot-1",
      activeBotId: { current: "bot-1" },
    });
    controls = useComputerControls({
      rpc: {
        computer: {
          boot: vi.fn(async () => null),
          takeover,
          release,
          screenUrl,
          status: vi.fn(async () => null),
          heartbeat: vi.fn(async () => ({ ok: true })),
        },
      } as never,
      state,
      panel: null,
      active: bot,
      bots: [bot],
      botsRef: { current: [bot] },
      activeBotId: { current: "bot-1" },
      activeGroupId: { current: undefined },
      runStatus: undefined,
      recording: false,
      sandboxProvider: undefined,
      refreshThread: vi.fn(async () => ({}) as never),
      refreshGroupThread: vi.fn(),
      onUpgrade: vi.fn(),
    });
    return null;
  }
  const free = {
    botId: "bot-1",
    mode: "team",
    kind: "boat",
    state: "running",
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: true,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
  } as const;
  const held = { ...free, controlHolder: "user", controlBotId: "bot-1" } as const;
  await act(async () => root.render(<Controls />));

  // Control taken for the bot elsewhere, from another tab or a phone, stays.
  await act(async () => state.commitComputer(held));
  await act(async () => state.setComputerOpen(true));
  await act(async () => state.setComputerOpen(false));
  expect(takeover).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();

  // Control this window took is handed back on close, even after a failed I'm done.
  await act(async () => state.commitComputer(free));
  await act(async () => state.setComputerOpen(true));
  expect(takeover).toHaveBeenCalledOnce();
  await act(async () => state.commitComputer(held));
  await act(async () => controls.finishControl());
  expect(state.computerOpen).toBe(true);
  expect(state.computerError).toBe("Could not continue");
  await act(async () => state.setComputerOpen(false));
  expect(release).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenLastCalledWith({ botId: "bot-1" });
});

it("asks for the bot switched to while another bot's answer is still on its way", async () => {
  const granted = new Set<string>();
  const takeover = vi.fn(({ botId }: { botId: string }) => {
    if (botId === "bot-1") return new Promise(() => undefined);
    granted.add(botId);
    return Promise.resolve({ leaseId: "l", expiresAt: "" });
  });
  const first = { id: "bot-1", name: "Ada" } as never;
  const second = { id: "bot-2", name: "Grace" } as never;
  function Controls() {
    state = useComputerState({
      rpc: { computer: { screenUrl } } as never,
      panel: null,
      activeId: "bot-1",
      activeBotId: { current: "bot-1" },
    });
    useComputerControls({
      rpc: {
        computer: {
          boot: vi.fn(async () => null),
          takeover,
          release: vi.fn(async () => ({ ok: true })),
          screenUrl,
          status: vi.fn(async ({ botId }: { botId: string }) =>
            granted.has(botId)
              ? { ...free(botId), controlHolder: "user", controlBotId: botId }
              : free(botId),
          ),
          heartbeat: vi.fn(async () => ({ ok: true })),
        },
      } as never,
      state,
      panel: null,
      active: first,
      bots: [first, second],
      botsRef: { current: [first, second] },
      activeBotId: { current: "bot-1" },
      activeGroupId: { current: undefined },
      runStatus: undefined,
      recording: false,
      sandboxProvider: undefined,
      refreshThread: vi.fn(async () => ({}) as never),
      refreshGroupThread: vi.fn(),
      onUpgrade: vi.fn(),
    });
    return null;
  }
  const free = (botId: string) =>
    ({
      botId,
      mode: "dedicated",
      kind: "boat",
      state: "running",
      controlHolder: "none",
      controlBotId: null,
      takeoverRequested: false,
      screenAvailable: true,
      screenWidth: 1280,
      screenHeight: 800,
      homeRevision: null,
      busyBotName: null,
      canUpdate: false,
      terminalAvailable: false,
    }) as const;
  await act(async () => root.render(<Controls />));
  await act(async () => state.commitComputer(free("bot-1")));
  await act(async () => state.setComputerOpen(true));
  expect(takeover).toHaveBeenCalledWith({ botId: "bot-1", ifAvailable: true });

  await act(async () => {
    state.setComputerBotId("bot-2");
    state.commitComputer(free("bot-2"));
  });
  expect(takeover).toHaveBeenLastCalledWith({ botId: "bot-2", ifAvailable: true });
});
