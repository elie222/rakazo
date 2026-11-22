// @vitest-environment jsdom

import type { ComposerMention } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MentionPicker } from "./composer-parts";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));

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
          activeIndex={1}
          onPick={vi.fn()}
          onHighlight={vi.fn()}
        />,
      ),
    );

    const labels = [...host.querySelectorAll('[role="option"]')].map((option) =>
      option.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["@Design, Bot", "@Design, Group", "@Notes", "@Planner", "@Writer"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
