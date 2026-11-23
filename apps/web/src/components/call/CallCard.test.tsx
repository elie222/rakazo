// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CallState } from "../../lib/calls/call-session";
import { answerCallApproval, endCall } from "../../lib/calls/call-session";
import { CallCard } from "./CallCard";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Input: "input",
  Textarea: "textarea",
  BotAvatar: () => null,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  defaultBotAvatarValue: () => "",
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn(), useParams: () => ({}) }));
let session: CallState | null = null;
vi.mock("../../lib/calls/call-session", () => ({
  answerCallApproval: vi.fn(async () => undefined),
  endCall: vi.fn(),
  setCallMinimized: vi.fn(),
  toggleMute: vi.fn(),
  toggleTranscript: vi.fn(),
  useCallSession: () => session,
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let composer: HTMLTextAreaElement;
/** Below md the call view covers the app. */
function viewport(width: number) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("matchMedia", () => ({
    matches: width < 768,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}
/** Base UI moves focus a microtask and an animation frame after a change. */
async function flushFocus() {
  await act(() => vi.advanceTimersByTimeAsync(50));
}
function render(call: Partial<CallState> | null) {
  session = call
    ? ({
        botId: "bot-1",
        botName: "Test bot",
        phase: "listening",
        exchanges: [],
        ...call,
      } as CallState)
    : null;
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <CallCard onSettings={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  composer = document.createElement("textarea");
  document.body.append(container, composer);
  composer.focus();
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  composer.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("takes focus on a phone screen, shuts out the app behind it, and gives focus back", async () => {
  viewport(375);
  render({});
  await flushFocus();
  const view = document.querySelector('[data-testid="call-view"]');
  expect(view?.getAttribute("role")).toBe("dialog");
  expect(view?.contains(document.activeElement)).toBe(true);
  expect(composer.closest('[aria-hidden="true"]')).not.toBeNull();
  render({ minimized: true });
  await flushFocus();
  expect(document.activeElement).toBe(composer);
  expect(composer.closest('[aria-hidden="true"]')).toBeNull();
});

it("still hangs up on Escape on a phone screen", async () => {
  viewport(375);
  render({});
  await flushFocus();
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(endCall).toHaveBeenCalledOnce();
});

it("leaves focus in the app beside the desktop card", async () => {
  viewport(1024);
  render({});
  await flushFocus();
  expect(container.querySelector('[data-testid="call-view"]')).not.toBeNull();
  expect(document.activeElement).toBe(composer);
  expect(composer.closest('[aria-hidden="true"]')).toBeNull();
});

it("reviews an outgoing draft and sends the edited values from the call", async () => {
  viewport(375);
  const values = {
    kind: "email" as const,
    to: "sam@example.test",
    subject: "Meeting",
    body: "Today at three",
  };
  render({
    caption: "Microphone disconnected",
    approval: {
      runId: "run",
      messageId: "draft",
      block: {
        kind: "ask",
        text: "Review draft",
        status: "pending",
        outgoingDraft: {
          source: "Mail",
          keys: { to: "to", subject: "subject", body: "body" },
          values,
        },
      },
    },
  });
  const draft = document.querySelector(
    '[data-testid="call-view"] [data-testid="outgoing-draft-card"]',
  )!;
  expect(draft.closest('[data-testid="call-view"]')?.textContent).toContain(
    "Microphone disconnected",
  );
  expect(draft.querySelector("textarea")?.value).toBe(values.to);
  const body = draft.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  expect(body.value).toBe(values.body);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      body,
      "Tomorrow at four",
    );
    body.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    [...draft.querySelectorAll("button")].find((button) => button.textContent === "Send")!.click(),
  );
  expect(answerCallApproval).toHaveBeenCalledWith(
    "draft",
    JSON.stringify({ outgoingDraft: { ...values, body: "Tomorrow at four" } }),
  );
});

it("keeps the running clock readable without including ticks in the live status", async () => {
  viewport(1024);
  vi.setSystemTime(31_000);
  render({ phase: "thinking", connectedAt: 0 });
  const live = container.querySelector('[aria-live="polite"]');
  const clock = [...container.querySelectorAll("span")].find(
    (span) => span.childElementCount === 0 && span.textContent === "00:31",
  );
  expect(clock).toBeDefined();
  expect(clock?.closest('[aria-live], [aria-hidden="true"]')).toBeNull();
  expect(live?.textContent).toBe("Thinking");

  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(clock?.textContent).toBe("00:32");
  expect(live?.textContent).toBe("Thinking");

  render({ phase: "speaking", connectedAt: 0 });
  expect(container.querySelector('[aria-live="polite"]')).toBe(live);
  expect(live?.textContent).toBe("Speaking");
});

it("announces Calling without showing a clock before connection", () => {
  viewport(1024);
  render({ phase: "ringing", connectedAt: null });
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("Calling…");
  expect(container.textContent).not.toMatch(/\d{2}:\d{2}/);
});

it("consumes call Escape before underlying document handlers", async () => {
  viewport(375);
  render({});
  await flushFocus();
  const underlyingClose = vi.fn();
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) underlyingClose();
  };
  document.addEventListener("keydown", onKey);
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  document.removeEventListener("keydown", onKey);
  expect(endCall).toHaveBeenCalledOnce();
  expect(underlyingClose).not.toHaveBeenCalled();
});
