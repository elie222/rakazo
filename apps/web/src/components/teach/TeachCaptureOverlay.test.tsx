// @vitest-environment jsdom

import type { TaughtSkill } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TeachCaptureOverlay } from "./TeachCaptureOverlay";

const computerInput = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../../lib/query/rpc", () => ({ rpc: { computer: { input: computerInput } } }));

const skill = {
  id: "skill-1",
  botId: "bot-1",
  name: "Export",
  goal: "Export weekly CRM list",
  status: "recording",
  playbook: {
    whenToUse: "",
    inputs: [],
    steps: [],
    howToCheck: "",
    whatToReturn: "",
    approvalBoundaries: "",
    failureHandling: "",
  },
  recording: { events: [], snapshots: [] },
  startedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:10:00.000Z",
  stoppedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as TaughtSkill;

const escapeInput = { botId: "bot-1", kind: "key", payload: { key: "Escape" } };

afterEach(() => {
  computerInput.mockClear();
  vi.unstubAllGlobals();
});

it("marks a recorded Escape as handled before the page's own Escape handler sees it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TeachCaptureOverlay botId="bot-1" skill={skill} enabled />);
  });
  // Stands in for the computer window's Escape handler, which listens on document in the bubble
  // phase and skips any Escape already prevented.
  const sawPrevented: boolean[] = [];
  const pageEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") sawPrevented.push(event.defaultPrevented);
  };
  document.addEventListener("keydown", pageEscape);
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  await vi.waitFor(() => expect(computerInput).toHaveBeenCalledWith(escapeInput));
  expect(sawPrevented).toEqual([true]);
  document.removeEventListener("keydown", pageEscape);
  act(() => root.unmount());
  container.remove();
});

it("leaves an Escape inside an open dialog to the dialog", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TeachCaptureOverlay botId="bot-1" skill={skill} enabled />);
  });
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.tabIndex = -1;
  document.body.append(dialog);
  const dialogEscape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  dialog.dispatchEvent(dialogEscape);
  expect(dialogEscape.defaultPrevented).toBe(false);
  // A later Escape on the page is recorded. Calls run in order, so once it is sent the dialog's
  // Escape, had it been recorded, would already have been sent too.
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  await vi.waitFor(() => expect(computerInput).toHaveBeenCalledWith(escapeInput));
  expect(computerInput).toHaveBeenCalledTimes(1);
  dialog.remove();
  act(() => root.unmount());
  container.remove();
});

it("sends a wheel scroll with the screen point it was made at", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <TeachCaptureOverlay
        botId="bot-1"
        skill={skill}
        enabled
        screenWidth={1280}
        screenHeight={800}
      />,
    );
  });
  const overlay = container.firstElementChild as HTMLElement;
  // The overlay shows the screen at half size.
  overlay.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400 }) as DOMRect;
  await act(async () => {
    overlay.dispatchEvent(
      new WheelEvent("wheel", { clientX: 300, clientY: 210, deltaY: 160, cancelable: true }),
    );
  });
  await vi.waitFor(() => expect(computerInput).toHaveBeenCalled());
  expect(computerInput).toHaveBeenCalledWith({
    botId: "bot-1",
    kind: "scroll",
    payload: { direction: "down", amount: 2, x: 600, y: 420 },
  });
  // A mostly sideways swipe scrolls right, at its own point.
  computerInput.mockClear();
  await act(async () => {
    overlay.dispatchEvent(
      new WheelEvent("wheel", {
        clientX: 100,
        clientY: 50,
        deltaX: 90,
        deltaY: 10,
        cancelable: true,
      }),
    );
  });
  await vi.waitFor(() => expect(computerInput).toHaveBeenCalled());
  expect(computerInput).toHaveBeenCalledWith({
    botId: "bot-1",
    kind: "scroll",
    payload: { direction: "right", amount: 1, x: 200, y: 100 },
  });
  act(() => root.unmount());
  container.remove();
});
