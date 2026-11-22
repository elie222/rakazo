// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { emptyRoutineDraftState, emptyWatchDraft } from "../../../lib/routines/routine-draft";
import { AddTriggerMenu } from "./add-trigger-menu";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("turns Use my computer off when a watch is added, since a watch's runs never get it", async () => {
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
        messageProviders={[]}
        emailAvailable={false}
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
    node.textContent?.includes("When something changes"),
  )!;
  await act(async () => item.click());
  expect(onChange).toHaveBeenCalledWith({
    ...draft,
    watch: emptyWatchDraft(),
    useComputer: false,
  });
  await act(async () => root.unmount());
});
