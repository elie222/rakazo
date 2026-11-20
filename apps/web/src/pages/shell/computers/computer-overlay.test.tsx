// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot, ComputerStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
vi.mock("../../../components/computers/SaveScreenshotButton", () => ({
  SaveScreenshotButton: ({ botId }: { botId: string }) => (
    <button type="button" data-testid="save-screenshot" data-bot={botId} />
  ),
}));
vi.mock("../../../components/teach/TeachCaptureOverlay", () => ({
  TeachCaptureOverlay: () => null,
}));
vi.mock("../../../components/teach/TeachComputerOverlay", () => ({
  TeachComputerOverlayControl: () => null,
}));
vi.mock("../../../components/teach/TeachRecordingChrome", () => ({
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
  options: { hasControl?: boolean; shared?: boolean; screenUrl?: string; error?: string } = {},
) {
  await act(async () => {
    root.render(
      <ComputerOverlay
        bot={bot}
        computer={{ ...computer(state), ...(options.shared ? { shared: true } : {}) }}
        computerViewport={null}
        recordingSkill={null}
        teachBusy={false}
        hasControl={options.hasControl ?? false}
        composerRunning={false}
        sending={false}
        booting={false}
        sendError={null}
        embeddedScreenUrl={options.screenUrl ?? null}
        screenFrameRef={() => undefined}
        computerScreenError={options.error ?? null}
        computerBooting={null}
        onStopTeaching={() => undefined}
        onStopRun={() => undefined}
        onRelease={async () => undefined}
        onTakeControl={() => undefined}
        onStart={onStart}
        onRefreshTeaching={async () => undefined}
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

it("offers to save a screenshot only while a live screen is showing", async () => {
  const save = () => container.querySelector<HTMLElement>('[data-testid="save-screenshot"]');
  const screenUrl = "/screen/session";
  await render("running", vi.fn(), { screenUrl });
  expect(save()?.dataset.bot).toBe("bot-1");
  await render("running", vi.fn(), { screenUrl, hasControl: true });
  expect(save()).not.toBeNull();
  // Nothing to capture while the screen is still loading, failed, or the computer is not running.
  await render("running");
  expect(save()).toBeNull();
  await render("running", vi.fn(), { screenUrl, error: "The screen did not respond." });
  expect(save()).toBeNull();
  await render("suspended", vi.fn(), { screenUrl });
  expect(save()).toBeNull();
});
