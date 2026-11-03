// @vitest-environment jsdom
import type { BillingStatus, Bot } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const billing = vi.hoisted(() => ({ status: null as Partial<BillingStatus> | null }));
const writeText = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@rakazo/ui-web", () => {
  const Plain = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    BotAvatar: () => null,
    GroupAvatar: () => null,
    Button: ({
      variant: _v,
      size: _s,
      ...props
    }: ComponentProps<"button"> & Record<string, unknown>) => <button type="button" {...props} />,
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Plain,
    DialogHeader: Plain,
    DialogTitle: Plain,
  };
});
vi.mock("../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/SubscriptionGate", () => ({
  useBilling: () => ({ status: billing.status, showPlans: () => undefined }),
}));

import { ChatHeader } from "./chat-header";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  billing.status = null;
  writeText.mockClear();
});

function renderHeader() {
  act(() =>
    root.render(
      <ChatHeader
        inGroup={false}
        active={{ id: "bot-1", name: "Helper", color: "#3EC5A8" } as Bot}
        activeGroup={undefined}
        activeSnapshot={null}
        phoneCallsEnabled={false}
        voiceReady={false}
        inCall={false}
        panelOpen={false}
        onOpenNavigation={() => undefined}
        onTogglePanel={() => undefined}
        onCall={() => undefined}
      />,
    ),
  );
}

const gift = () => container.querySelector<HTMLButtonElement>('[aria-label="Invite a friend"]');

it("shows no gift when the account cannot invite", () => {
  billing.status = { referral: null };
  renderHeader();
  expect(gift()).toBeNull();
});

it("opens the invite with both rewards and copies the link", async () => {
  billing.status = { referral: { url: "https://example.test/sign-up?ref=abc", rewards: 2 } };
  renderHeader();
  act(() => gift()!.click());
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Give a friend 2 weeks free");
  expect(dialog.textContent).toContain("They get 2 weeks free.");
  expect(dialog.textContent).toContain("You get a free month when they start their trial.");
  expect(dialog.textContent).toContain("2 free months earned");
  const copy = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Copy link",
  )!;
  await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledWith("https://example.test/sign-up?ref=abc");
  expect(dialog.textContent).toContain("Copied");
});
