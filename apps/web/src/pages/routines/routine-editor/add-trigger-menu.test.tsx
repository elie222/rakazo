// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { emptyRoutineDraftState, emptyWatchDraft } from "../../../lib/routines/routine-draft";
import { AddTriggerMenu } from "./add-trigger-menu";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in strings ? strings.message : String.raw(strings, ...values),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each([
  ["When something changes", { watch: emptyWatchDraft() }],
  ["Email", { emailSenders: "owner" }],
  ["Slack message", { messageProvider: "slack" }],
  ["Git event", { githubEnabled: true }],
  ["Webhook", { webhookEnabled: true }],
])(
  "turns Use my computer off when %s is added, since the server refuses it then",
  async (label, added) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const draft = { ...emptyRoutineDraftState(), useComputer: true };
    const onChange = vi.fn();
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        <AddTriggerMenu
          draft={draft}
          onChange={onChange}
          fieldId="routine"
          messageProviders={["slack"]}
          emailAvailable
          webhookConfigured
          onEnsureWebhook={async () => undefined}
        />,
      ),
    );
    const button = [...document.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Add trigger"),
    )!;
    await act(async () => button.click());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
      node.textContent?.includes(label),
    )!;
    await act(async () => item.click());
    expect(onChange).toHaveBeenCalledWith({ ...draft, ...added, useComputer: false });
    await act(async () => root.unmount());
  },
);
