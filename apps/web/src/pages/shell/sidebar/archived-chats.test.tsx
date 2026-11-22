// @vitest-environment jsdom
import type { Bot, Group } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import { ArchivedChats } from "./archived-chats";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  GroupAvatar: () => null,
  Button: ({ children, onClick, "aria-label": label }: ComponentProps<"button">) => (
    <button type="button" onClick={onClick} aria-label={label}>
      {children}
    </button>
  ),
  ContextMenu: ({ children }: { children: ReactNode }) => children,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children, "aria-label": label }: ComponentProps<"div">) => (
    <div role="menu" aria-label={label}>
      {children}
    </div>
  ),
  ContextMenuItem: ({ children, onClick }: ComponentProps<"button">) => (
    <button type="button" role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
  toast,
}));
vi.mock("./sidebar-shelf", () => ({
  SidebarShelf: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const restoreBot = vi.fn<(input: { botId: string }) => Promise<unknown>>();
const restoreGroup = vi.fn<(input: { groupId: string }) => Promise<unknown>>();
const refreshBots = vi.fn<(includeArchived?: boolean) => Promise<void>>();
const archivedGroup: Group = {
  id: "fixture-group",
  spaceId: "fixture-space",
  name: "Sample group",
  pinned: false,
  sectionId: null,
  archivedAt: "2026-11-01T00:00:00.000Z",
  members: [],
  threadId: "fixture-group-thread",
  preview: "",
  unread: false,
  updatedAt: "2026-11-01T00:00:00.000Z",
  createdAt: "2026-10-31T00:00:00.000Z",
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  toast.error.mockClear();
  restoreBot.mockReset().mockResolvedValue(undefined);
  restoreGroup.mockReset().mockResolvedValue(undefined);
  refreshBots.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  const rpc = {
    bots: { restore: restoreBot },
    groups: { restore: restoreGroup },
  } as unknown as ReturnType<typeof createSpaceRpc>;
  await act(async () =>
    root.render(
      <ArchivedChats
        archivedBots={[{ id: "fixture-bot", name: "Sample bot" } as Bot]}
        archivedGroups={[archivedGroup]}
        showSpaceSearch={false}
        rpc={rpc}
        refreshBots={refreshBots}
        setDeleteTarget={vi.fn()}
        setDeleteGroupTarget={vi.fn()}
      />,
    ),
  );
}

const botButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Restore Sample bot"]')!;
function groupMenuItem() {
  const items = container.querySelectorAll<HTMLButtonElement>(
    '[role="menu"][aria-label="Actions for Sample group"] [role="menuitem"]',
  );
  return [...items].find((item) => item.textContent === "Restore")!;
}

it.each([
  { action: "bot button", button: botButton, restore: restoreBot, input: { botId: "fixture-bot" } },
  {
    action: "group menu",
    button: groupMenuItem,
    restore: restoreGroup,
    input: { groupId: "fixture-group" },
  },
])(
  "reports a failed restore from the $action and permits a retry",
  async ({ button, restore, input }) => {
    restore.mockRejectedValueOnce(new Error("offline"));
    await render();
    await act(async () => button().click());
    expect(restore).toHaveBeenCalledExactlyOnceWith(input);
    expect(refreshBots).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("Could not restore chat. Try again.");

    await act(async () => button().click());
    expect(restore.mock.calls).toEqual([[input], [input]]);
    expect(refreshBots).toHaveBeenCalledExactlyOnceWith(true);
    expect(toast.error).toHaveBeenCalledTimes(1);
  },
);

it("reports a failed refresh without calling the successful restore a failure", async () => {
  refreshBots.mockRejectedValueOnce(new Error("offline"));
  await render();
  await act(async () => botButton().click());
  expect(restoreBot).toHaveBeenCalledExactlyOnceWith({ botId: "fixture-bot" });
  expect(refreshBots).toHaveBeenCalledExactlyOnceWith(true);
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    "Chat restored, but the list could not refresh.",
  );
});

it("refreshes only after restore succeeds and shows no error", async () => {
  const restore = deferred();
  restoreBot.mockReturnValueOnce(restore.promise);
  await render();
  await act(async () => botButton().click());
  expect(refreshBots).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();

  await act(async () => restore.resolve());
  expect(refreshBots).toHaveBeenCalledExactlyOnceWith(true);
  expect(toast.error).not.toHaveBeenCalled();
});
