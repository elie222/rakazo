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
vi.mock("../../components/ComputersUnavailableHint", () => ({
  ComputersUnavailableHint: () => null,
}));

import { ComputerPanel } from "./computer-panel";

let container: HTMLDivElement;
let root: Root;

const bot = { id: "bot-1", name: "Ada" } as Bot;

function computer(state: ComputerStatus["state"]): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "boat",
    state,
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: state === "running",
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
  };
}

async function render(status: ComputerStatus | null, onOpen = vi.fn()) {
  await act(async () => {
    root.render(
      <ComputerPanel
        bot={bot}
        computer={status}
        computerOpen={false}
        embeddedScreenUrl="https://screen.example.test/"
        screenFrameRef={() => undefined}
        computerScreenError={null}
        computerBooting={null}
        booting={false}
        showingRecoveryHint={false}
        showComputerRecoveryHint={false}
        onRecovered={() => undefined}
        onRecoveryDismissed={() => undefined}
        onOpen={onOpen}
      />,
    );
  });
  return onOpen;
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

it.each([null, computer("stopped"), computer("suspended")])(
  "shows an idle computer asleep until its Wake button is pressed",
  async (status) => {
    const onOpen = await render(status);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-state="idle"]')?.textContent).toContain("Asleep");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="computer-preview-open"]')?.click(),
    );
    expect(onOpen).toHaveBeenCalledOnce();
  },
);

it("previews a running computer's screen", async () => {
  await render(computer("running"));
  expect(container.querySelector('[data-state="idle"]')).toBeNull();
  expect(container.querySelector("iframe")).not.toBeNull();
});
