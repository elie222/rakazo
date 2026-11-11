// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot, ComputerReleaseReason, ComputerStatus, Run } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("../../components/ComputerMaintenanceActions", () => ({
  ComputerMaintenanceActions: () => null,
}));
vi.mock("../../components/teach/TeachCaptureOverlay", () => ({ TeachCaptureOverlay: () => null }));
vi.mock("../../components/teach/TeachComputerOverlay", () => ({
  TeachComputerOverlayControl: () => null,
}));
vi.mock("../../components/teach/TeachRecordingChrome", () => ({
  TeachRecordingChrome: () => null,
  TeachStopButton: () => null,
}));

import { ComputerOverlay } from "./computer-overlay";

let container: HTMLDivElement;
let root: Root;

const bot = { id: "bot-1", name: "Ada", color: "ink", status: "idle" } as Bot;

function computer(state: ComputerStatus["state"]): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "boat",
    state,
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
  };
}

async function render(
  state: ComputerStatus["state"],
  onStart = vi.fn(),
  options: {
    hasControl?: boolean;
    shared?: boolean;
    status?: Partial<ComputerStatus>;
    screenUrl?: string;
    runStatus?: Run["status"];
    onFinish?: (reason?: ComputerReleaseReason) => void;
    screenError?: ReactNode;
  } = {},
) {
  await act(async () => {
    root.render(
      <ComputerOverlay
        bot={bot}
        computer={{
          ...computer(state),
          ...(options.shared ? { shared: true } : {}),
          ...options.status,
        }}
        computerViewport={null}
        recordingSkill={null}
        teachBusy={false}
        hasControl={options.hasControl ?? false}
        composerRunning={false}
        sending={false}
        runStatus={options.runStatus}
        sendError={null}
        embeddedScreenUrl={options.screenUrl ?? null}
        screenFrameRef={() => undefined}
        computerScreenError={options.screenError ?? null}
        computerBooting={null}
        onStopTeaching={() => undefined}
        onStopRun={() => undefined}
        onFinish={options.onFinish ?? (() => undefined)}
        onStart={onStart}
        onRefreshTeaching={async () => undefined}
        onRefreshComputer={async () => undefined}
        onClose={() => undefined}
      />,
    );
  });
  return onStart;
}

function startButton() {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === "Start");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("offers Start for a stopped computer instead of a bare label", async () => {
  const onStart = await render("stopped");
  expect(container.textContent).toContain("Computer is stopped");
  await act(async () => startButton()?.click());
  expect(onStart).toHaveBeenCalledOnce();
});

it("offers Start for an asleep computer", async () => {
  await render("suspended");
  expect(container.textContent).toContain("Computer is asleep");
  expect(startButton()).toBeDefined();
});

it("says sign-ins are shared while someone in a shared space has control", async () => {
  const note = () => container.querySelector('[data-testid="computer-shared-browser"]');
  await render("running", vi.fn(), { hasControl: true, shared: true });
  expect(note()?.textContent).toBe(
    "Sites you sign in to stay signed in for everyone in this space",
  );
  await render("running", vi.fn(), { hasControl: true });
  expect(note()).toBeNull();
  await render("running", vi.fn(), { shared: true });
  expect(note()).toBeNull();
});

describe("control pill", () => {
  const screen = "https://screen.example.test/";
  const pill = () => container.querySelector('[data-testid="computer-control-pill"]');
  const button = (label: string) =>
    [...(pill()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);

  it("hands control back with I’m done and never offers Take control", async () => {
    const onFinish = vi.fn();
    await render("running", vi.fn(), {
      hasControl: true,
      screenUrl: screen,
      status: { controlHolder: "user", controlBotId: "bot-1" },
      onFinish,
    });
    expect(pill()?.textContent).toContain("You’re in control");
    expect(button("Skip")).toBeUndefined();
    await act(async () => button("I’m done")?.click());
    expect(onFinish).toHaveBeenCalledWith(undefined);
    expect(container.textContent).not.toContain("Take control");
  });

  it("lets a waiting bot continue with I’m done or Skip", async () => {
    const onFinish = vi.fn();
    await render("running", vi.fn(), {
      hasControl: true,
      screenUrl: screen,
      status: { takeoverRequested: true, controlHolder: "user", controlBotId: "bot-1" },
      onFinish,
    });
    await act(async () => button("Skip")?.click());
    await act(async () => button("I’m done")?.click());
    expect(onFinish.mock.calls).toEqual([["skipped"], ["done"]]);
  });

  it("keeps a waiting bot answerable when the screen fails", async () => {
    const onFinish = vi.fn();
    await render("running", vi.fn(), {
      hasControl: true,
      screenError: <p role="alert">Screen not connected</p>,
      status: { takeoverRequested: true, controlHolder: "user", controlBotId: "bot-1" },
      onFinish,
    });
    expect(container.querySelector("iframe")).toBeNull();
    await act(async () => button("I’m done")?.click());
    expect(onFinish).toHaveBeenCalledWith("done");
  });

  it("names who has control of a shared computer, with nothing to press", async () => {
    await render("running", vi.fn(), {
      screenUrl: screen,
      status: { controlHolder: "user", controlledByOther: true, controlledByName: "Grace" },
    });
    expect(pill()?.textContent).toBe("Grace is in control");
    expect(pill()?.querySelector("button")).toBeNull();
    expect(container.querySelector("iframe")?.style.pointerEvents).toBe("none");
  });

  it("shows a running bot at work while the screen stays read-only", async () => {
    await render("running", vi.fn(), {
      screenUrl: screen,
      status: { busyBotName: "Ada" },
      runStatus: "running",
    });
    expect(pill()?.textContent).toBe("Ada is working");
    expect(pill()?.querySelector("button")).toBeNull();
  });
});
