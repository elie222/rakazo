// @vitest-environment jsdom

import { buildComposerMentionOptions, mentionConnectorsFrom } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MentionPicker } from "./composer-parts";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));

it("announces missing kinds for same-name cross-kind options without losing their subtitles", async () => {
  const options = buildComposerMentionOptions({
    query: "",
    bots: [
      { id: "bot-notes", name: "Weekly Notes" },
      { id: "bot-workspace", name: "Workspace" },
      { id: "bot-writer", name: "Writer" },
      { id: "bot-writer-two", name: "Writer" },
    ],
    groups: [{ id: "group-team", name: "Team" }],
    routines: [
      { id: "routine-notes", name: "Weekly Notes", crons: ["0 9 * * 1"], botId: "bot-notes" },
      { id: "routine-sync", name: "Sync", crons: [], botId: "bot-notes" },
    ],
    connectors: mentionConnectorsFrom(
      [],
      [
        {
          connectorId: "connector-workspace",
          slug: "workspace",
          name: "Workspace",
          connected: false,
          noAuth: false,
        },
        {
          connectorId: "connector-sync",
          slug: "sync",
          name: "Sync",
          connected: false,
          noAuth: false,
        },
      ],
    ),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const onPick = vi.fn();
  const onHighlight = vi.fn();
  const render = async (mentions: typeof options, activeIndex: number) => {
    await act(async () =>
      root.render(
        <MentionPicker
          listboxId="test-mentions"
          options={mentions}
          activeIndex={activeIndex}
          onPick={onPick}
          onHighlight={onHighlight}
        />,
      ),
    );
    return [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  };

  try {
    const rows = await render(options, 5);
    expect(rows.map((option) => option.getAttribute("aria-label"))).toEqual([
      "@Weekly Notes, Bot",
      "@Workspace, Bot",
      "@Writer, Bot",
      "@Writer, Bot",
      "@Team",
      "@Weekly Notes, Routine, Every Monday at 9:00 AM",
      "@Sync, Routine",
      "@Workspace, Connector, Needs auth",
      "@Sync, Connector, Needs auth",
    ]);
    expect(rows[5]?.textContent).toContain("Every Monday at 9:00 AM");
    expect(rows[7]?.textContent).toContain("Needs auth");
    expect(rows[5]?.id).toBe("test-mentions-option-5");
    expect(rows[5]?.getAttribute("aria-selected")).toBe("true");

    await act(async () => rows[5]?.click());
    expect(onPick).toHaveBeenCalledExactlyOnceWith(options[5]);
    expect(onHighlight).not.toHaveBeenCalled();

    const filteredRows = await render(
      options.filter(({ kind }) => kind !== "routine"),
      0,
    );
    expect(filteredRows[0]?.getAttribute("aria-label")).toBe("@Weekly Notes");
    expect(filteredRows[1]?.getAttribute("aria-label")).toBe("@Workspace, Bot");
    expect(filteredRows.at(-1)?.getAttribute("aria-label")).toBe("@Sync");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
