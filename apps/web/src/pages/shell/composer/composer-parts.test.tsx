// @vitest-environment jsdom

import type { ComposerMention } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MentionPicker } from "./composer-parts";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));

async function renderLabels(options: ComposerMention[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MentionPicker
          listboxId="test-mentions"
          options={options}
          activeIndex={0}
          onPick={vi.fn()}
          onHighlight={vi.fn()}
        />,
      ),
    );
    return [...host.querySelectorAll('[role="option"]')].map((option) =>
      option.getAttribute("aria-label"),
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
}

it("adds the visible subtitle to the names of options that share a name", async () => {
  const bot = { kind: "bot", id: "bot-1", name: "Design", subtitle: "Bot" } as const;
  const group = { kind: "group", id: "group-1", name: "Design", subtitle: "Group" } as const;
  const routine = {
    kind: "routine",
    id: "routine-1",
    name: "Notes",
    subtitle: "Every day",
  } as const;
  const withoutSubtitle = { kind: "bot", id: "bot-2", name: "Planner" } as const;
  const uniqueBot = { kind: "bot", id: "bot-3", name: "Writer", subtitle: "Bot" } as const;
  const options: ComposerMention[] = [bot, group, routine, withoutSubtitle, uniqueBot];
  expect(await renderLabels(options)).toEqual([
    "@Design, Bot",
    "@Design, Group",
    "@Notes",
    "@Planner",
    "@Writer",
  ]);
});

it("names the kind of routines and connectors that share a name", async () => {
  const routine = { kind: "routine", id: "routine-1", name: "Sync" } as const;
  const connector = {
    kind: "connector",
    id: "connector-1",
    name: "Sync",
    subtitle: "Needs auth",
  } as const;
  expect(await renderLabels([routine, connector])).toEqual([
    "@Sync, Routine",
    "@Sync, Connector, Needs auth",
  ]);
});
