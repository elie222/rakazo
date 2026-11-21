import { useLingui } from "@lingui/react/macro";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@rakazo/ui-web";
import type { ChatMenuPrimitives, ChatMenuProps } from "./chat-menu-items";
import { ChatMenuItems } from "./chat-menu-items";

const contextPrimitives: ChatMenuPrimitives = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

const dropdownPrimitives: ChatMenuPrimitives = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

/**
 * A roster row's menu content. The right-click surface opens at the pointer; the row's
 * "More" button opens the same items at its own edge, so neither covers the row link.
 */
export function BotContextMenu({
  surface = "context",
  ...props
}: ChatMenuProps & { surface?: "context" | "dropdown" }) {
  const { t } = useLingui();
  const label = t`Actions for ${props.bot.name}`;
  if (surface === "dropdown") {
    return (
      <DropdownMenuContent
        aria-label={label}
        align="end"
        side="bottom"
        className="max-h-[min(420px,calc(100vh-16px))] w-[264px] overflow-y-auto"
      >
        <ChatMenuItems primitives={dropdownPrimitives} {...props} />
      </DropdownMenuContent>
    );
  }
  return (
    <ContextMenuContent
      aria-label={label}
      className="max-h-[min(420px,calc(100vh-16px))] w-[264px] overflow-y-auto"
    >
      <ChatMenuItems primitives={contextPrimitives} {...props} />
    </ContextMenuContent>
  );
}
