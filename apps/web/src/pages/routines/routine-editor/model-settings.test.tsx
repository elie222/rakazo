// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RoutineDraftState } from "../../../lib/routines/routine-draft";
import { emptyRoutineDraftState, emptyWatchDraft } from "../../../lib/routines/routine-draft";
import { RoutineModelSettings } from "./model-settings";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../lib/query/rpc", () => ({
  rpc: { models: { credentials: async () => [], list: async () => [] } },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function open(draft: RoutineDraftState, onChange = vi.fn()) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(<RoutineModelSettings draft={draft} onChange={onChange} fieldId="routine" />),
  );
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Advanced"]')!;
  await act(async () => trigger.click());
  return { root, onChange, trigger };
}

const inChatSwitch = () => document.getElementById("routine-in-chat") as HTMLButtonElement | null;

it("turns on running in the chat from the advanced settings", async () => {
  const draft = emptyRoutineDraftState();
  const { root, onChange } = await open(draft);

  expect(inChatSwitch()?.closest("label")?.textContent).toContain("Run in the chat");
  await act(async () => inChatSwitch()!.click());
  expect(onChange).toHaveBeenCalledWith({ ...draft, inChat: true });
  await act(async () => root.unmount());
});

it("marks the advanced button only when the routine runs in the chat", async () => {
  const quiet = await open(emptyRoutineDraftState());
  expect(quiet.trigger.querySelector("span[aria-hidden]")).toBeNull();
  await act(async () => quiet.root.unmount());
  document.body.replaceChildren();
  const { root, trigger } = await open({ ...emptyRoutineDraftState(), inChat: true });

  expect(trigger.querySelector("span[aria-hidden]")).not.toBeNull();
  await act(async () => root.unmount());
});

it("offers no in-chat switch to a routine that watches for changes", async () => {
  const { root } = await open({
    ...emptyRoutineDraftState(),
    inChat: true,
    watch: emptyWatchDraft(),
  });

  expect(inChatSwitch()).toBeNull();
  await act(async () => root.unmount());
});
