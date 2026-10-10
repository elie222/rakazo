// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ComponentType, ReactElement } from "react";
import * as React from "react";
import { act, memo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import type { MobileBot } from "./api";
import { retainInboxValue } from "./inbox-retention";

const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/index.tsx", testFileUrl), "utf8");

// Run the actual row and renderItem code with native presentation stubbed out.
// React still performs real memo comparisons; this measures JS row executions only.
function measure(before: boolean) {
  let renders = 0;
  const rowSource = source.slice(
    source.indexOf("const BotRow = memo("),
    source.indexOf("const GroupRow = memo("),
  );
  const listSource = source.slice(
    source.indexOf("  const renderItem = useCallback("),
    source.indexOf("  if (!ready) {"),
  );
  const scope = {
    React,
    memo: before ? (component: ComponentType) => component : memo,
    useCallback,
    useI18n: () => ({ t: (text: string) => text }),
    previewSnippet: (text: string) => text,
    formatThreadTime: () => "",
    botTag: () => "",
    ACTIVE_RUN_STATUSES: ["running"],
    mobileBotAvatarPresentation: () => {
      renders++;
      return { kind: "color", color: "gray" };
    },
    FALLBACK_COLOR: "gray",
    ConversationRow: () => null,
    BotAvatar: () => null,
    WorkingIndicator: () => null,
  };
  const compile = (text: string) =>
    ts.transpileModule(text, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;
  const BotRow = new Function(...Object.keys(scope), compile(`${rowSource}\nreturn BotRow;`))(
    ...Object.values(scope),
  );
  const action = vi.fn();
  const dependencies = {
    React,
    useCallback,
    BotRow,
    appearance: "light",
    chooseInboxSpace: action,
    collapsedRosterParents: new Set(),
    confirmDeleteSpace: action,
    me: { spaceId: "space-1" },
    openBot: action,
    openGroup: action,
    openSearchHit: action,
    organizeBot: action,
    organizeGroup: action,
    spaceBusy: false,
    spaceRecoveryId: null,
    styles: {},
    t: action,
    toggleRosterParent: action,
  };
  const useRenderItem = new Function(
    ...Object.keys(dependencies),
    compile(`${listSource}\nreturn renderItem;`),
  );
  let previousRenderItem: unknown;
  function List({ bots }: { bots: MobileBot[] }) {
    const renderItem = useRenderItem(...Object.values(dependencies)) as (info: {
      item: unknown;
    }) => ReactElement;
    if (previousRenderItem) expect(renderItem).toBe(previousRenderItem);
    previousRenderItem = renderItem;
    return bots.map((bot) =>
      before ? (
        <BotRow
          key={bot.id}
          bot={bot}
          onPress={() => action(bot)}
          onLongPress={() => action(bot)}
        />
      ) : (
        React.cloneElement(
          renderItem({ item: { type: "bot", bot, depth: 0, hasChildren: false } }),
          { key: bot.id },
        )
      ),
    );
  }
  let bots = Array.from({ length: 30 }, (_, index) => ({
    id: `bot-${index}`,
    name: `Helper ${index}`,
    spaceId: "space-1",
    preview: "",
    title: "",
    color: "gray",
    status: "idle",
    notifyOnFinish: true,
    unread: false,
  })) as MobileBot[];
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<List bots={bots} />));
    const mount = renders;
    for (let poll = 0; poll < 12; poll++) {
      const fetched = structuredClone(bots);
      bots = before ? fetched : retainInboxValue(bots, fetched);
      // Force parent rendering too, as with activity/refresh state changes.
      act(() => root.render(<List bots={bots} />));
    }
    const idle = renders - mount;
    const fetched = structuredClone(bots);
    fetched[0]!.status = "running";
    fetched[0]!.unread = true;
    bots = before ? fetched : retainInboxValue(bots, fetched);
    act(() => root.render(<List bots={bots} />));
    return { mount, idle, changed: renders - mount - idle };
  } finally {
    act(() => root.unmount());
  }
}

it("skips unchanged inbox rows for 12 idle polls and renders the changed bot", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    expect(measure(true)).toEqual({ mount: 30, idle: 360, changed: 30 });
    expect(measure(false)).toEqual({ mount: 30, idle: 0, changed: 1 });
  } finally {
    vi.unstubAllGlobals();
  }
});
