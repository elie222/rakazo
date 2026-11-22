import type { Bot, BotSection, Group } from "@rakazo/contracts";
import { chatSnoozed } from "@rakazo/core";
import { Button, ContextMenu, DropdownMenu, DropdownMenuTrigger } from "@rakazo/ui-web";
import type { ComponentProps, Dispatch, ReactNode, SetStateAction } from "react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { lazyOverlay } from "../../../components/ErrorBoundary";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import type { ShellDialogsState } from "../shell-dialogs";
import type { SnoozeChat } from "../sidebar/use-chat-snooze";
import type { useChatRead } from "./use-chat-read";

const BotContextMenu = lazyOverlay(() =>
  import("./bot-context-menu").then((module) => module.BotContextMenu),
);

type ChatRead = ReturnType<typeof useChatRead>;

export type ChatMenuSurface = "context" | "dropdown";

export type ChatMenuTarget = {
  kind: "bot" | "group";
  id: string;
  /** Which control opened the menu; a row has both a right-click area and a "More" button. */
  via?: ChatMenuSurface;
};

/** Which chat's right-click menu is open, shared by the roster and search results. */
export type ChatMenuState = {
  menu: ChatMenuTarget | null;
  setMenu: Dispatch<SetStateAction<ChatMenuTarget | null>>;
  /** The menu items, rendered for the surface that opened them. */
  content: (surface: ChatMenuSurface) => ReactNode;
  /** Whether the menu can act on this chat. */
  has: (target: ChatMenuTarget) => boolean;
};

/** The shared chat menu's state, and the menu for whichever roster chat it is open on. */
export function useChatMenu({
  bots,
  groups,
  ...menuProps
}: { bots: Bot[]; groups: Group[] } & Omit<
  ComponentProps<typeof ChatContextMenu>,
  "bot" | "group" | "onClose"
>): ChatMenuState {
  const [menu, setMenu] = useState<ChatMenuTarget | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const bot = menu?.kind === "bot" ? bots.find((item) => item.id === menu.id) : undefined;
  const group = menu?.kind === "group" ? groups.find((item) => item.id === menu.id) : undefined;
  return {
    menu,
    setMenu,
    content: (surface) =>
      bot || group ? (
        <ChatContextMenu {...menuProps} surface={surface} bot={bot} group={group} onClose={close} />
      ) : null,
    // Search can list a chat the roster doesn't hold; it has no menu to show.
    has: (target) =>
      target.kind === "bot"
        ? bots.some((item) => item.id === target.id)
        : groups.some((item) => item.id === target.id),
  };
}

/** Opens the shared chat menu when its trigger child is right-clicked. */
export function ChatMenu({
  target,
  state,
  disabled,
  children,
}: {
  target: ChatMenuTarget;
  state: ChatMenuState;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { menu, setMenu, content } = state;
  const { kind, id } = target;
  const open = menu?.kind === kind && menu.id === id && (menu.via ?? "context") === "context";
  // The menu doesn't report closing when it unmounts open, such as when new search results
  // replace this row; release it so it can't reopen on its own later.
  useEffect(() => {
    if (!open) return;
    return () =>
      setMenu((current) =>
        current?.kind === kind && current.id === id && (current.via ?? "context") === "context"
          ? null
          : current,
      );
  }, [open, kind, id, setMenu]);
  return (
    <ContextMenu
      disabled={disabled}
      open={open}
      // A sibling row's menu may already own the state; only clear our own.
      onOpenChange={(next) =>
        setMenu((current) =>
          next
            ? { kind, id, via: "context" }
            : current?.kind === kind &&
                current.id === id &&
                (current.via ?? "context") === "context"
              ? null
              : current,
        )
      }
    >
      {children}
      {open ? <Suspense fallback={null}>{content("context")}</Suspense> : null}
    </ContextMenu>
  );
}

/**
 * The row's "More" button. It shows the same menu as a right-click, anchored to the
 * button, so the row link keeps its whole area and a single menu is open at a time.
 */
export function ChatRowMenu({
  target,
  state,
  disabled,
  label,
  children,
}: {
  target: ChatMenuTarget;
  state: ChatMenuState;
  disabled?: boolean;
  /** The button's accessible name, such as "Actions for Design". */
  label: string;
  children: ReactNode;
}) {
  const { menu, setMenu, content } = state;
  const { kind, id } = target;
  const open = menu?.kind === kind && menu.id === id && menu.via === "dropdown";
  useEffect(() => {
    if (!open) return;
    return () =>
      setMenu((current) =>
        current?.kind === kind && current.id === id && current.via === "dropdown" ? null : current,
      );
  }, [open, kind, id, setMenu]);
  return (
    <DropdownMenu
      disabled={disabled}
      open={open}
      onOpenChange={(next) =>
        setMenu((current) =>
          next
            ? { kind, id, via: "dropdown" }
            : current?.kind === kind && current.id === id && current.via === "dropdown"
              ? null
              : current,
        )
      }
    >
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} />}>
        {children}
      </DropdownMenuTrigger>
      {open ? <Suspense fallback={null}>{content("dropdown")}</Suspense> : null}
    </DropdownMenu>
  );
}

/** The right-click menu for a bot or group in the roster or search results. */
export function ChatContextMenu({
  surface = "context",
  rpc,
  bot,
  group,
  sections,
  spaceId,
  onClose,
  refreshBots,
  read,
  snooze,
  dialogs,
  openChatSettings,
  navigate,
}: {
  surface?: ChatMenuSurface;
  rpc: ReturnType<typeof createSpaceRpc>;
  bot: Bot | undefined;
  group: Group | undefined;
  sections: BotSection[];
  spaceId: string | undefined;
  onClose: () => void;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  read: Pick<ChatRead, "markBotRead" | "markBotUnread" | "toggleGroupUnread">;
  snooze: SnoozeChat;
  dialogs: ShellDialogsState;
  openChatSettings: (kind: "bot" | "group", id: string) => void;
  navigate: (path: string) => void;
}) {
  const chat = bot ?? group;
  if (!chat) return null;
  const target = bot
    ? { kind: "bot" as const, chat: bot }
    : { kind: "group" as const, chat: group! };
  return (
    <BotContextMenu
      surface={surface}
      bot={chat}
      onClose={onClose}
      sections={sections}
      onTogglePinned={() => {
        onClose();
        const request = bot
          ? rpc.bots.update({ botId: bot.id, pinned: !bot.pinned })
          : rpc.groups.update({
              groupId: group!.id,
              pinned: !group!.pinned,
            });
        void request.then(() => refreshBots());
      }}
      onToggleUnread={() => {
        const unread = !chat.unread;
        onClose();
        if (bot) {
          const request = unread ? read.markBotUnread(bot.id) : read.markBotRead(bot.id);
          void request.catch(() => undefined);
        } else {
          read.toggleGroupUnread(group!.id, unread);
        }
      }}
      snoozed={chatSnoozed({ snoozedUntil: chat.snoozedUntil }, Date.now())}
      onSnooze={(until) => {
        onClose();
        snooze({ kind: target.kind, ...chat }, until);
      }}
      onMoveToSection={(sectionId) => {
        onClose();
        if (sectionId === chat.sectionId) return;
        const request = bot
          ? rpc.bots.update({ botId: bot.id, sectionId })
          : rpc.groups.update({ groupId: group!.id, sectionId });
        void request.then(() => refreshBots());
      }}
      onCreateSection={() => {
        dialogs.setNewSectionTarget(target);
        onClose();
      }}
      onRenameSection={(sectionId) => {
        const section = sections.find((item) => item.id === sectionId);
        if (section && spaceId) dialogs.setRenameSectionTarget({ section, spaceId });
        onClose();
      }}
      onEdit={() => {
        openChatSettings(bot ? "bot" : "group", chat.id);
        onClose();
      }}
      onDuplicate={() => {
        onClose();
        const request = bot
          ? rpc.bots.duplicate({ botId: bot.id })
          : rpc.groups.duplicate({ groupId: group!.id });
        void request.then(async (copy) => {
          await refreshBots();
          navigate(bot ? `/app/${copy.id}` : `/app/g/${copy.id}`);
        });
      }}
      onClear={() => {
        dialogs.setClearTarget(target);
        onClose();
      }}
      onArchive={() => {
        onClose();
        const request = bot
          ? rpc.bots.archive({ botId: bot.id })
          : rpc.groups.archive({ groupId: group!.id });
        void request.then(() => refreshBots(true));
      }}
      onDelete={() => {
        if (bot) dialogs.setDeleteTarget(bot);
        else dialogs.setDeleteGroupTarget(group!);
        onClose();
      }}
    />
  );
}
