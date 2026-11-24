import { ContextMenu, Host, RNHostView } from "@expo/ui/swift-ui";
import { contentShape, shapes } from "@expo/ui/swift-ui/modifiers";
import { useResolvedAppearance } from "../../lib/native/native";
import { ChatMenuItems } from "./chat-menu-items.ios";
import type { ChatTileMenuProps } from "./chat-tile-menu";
import { InboxChatPreview } from "./inbox-chat-preview";

/** A pinned tile with the system context menu its chat's inbox row has. */
export function ChatTileMenu({ width, preview, children, ...menu }: ChatTileMenuProps) {
  const scheme = useResolvedAppearance();
  // The host keeps the size it first measured, so it waits for the tile's width.
  if (width === undefined) return null;
  return (
    <Host key={width} matchContents colorScheme={scheme}>
      <ContextMenu modifiers={[contentShape(shapes.roundedRectangle({ cornerRadius: 16 }))]}>
        <ContextMenu.Trigger>
          <RNHostView matchContents>{children}</RNHostView>
        </ContextMenu.Trigger>
        <ContextMenu.Preview>
          <InboxChatPreview {...preview} />
        </ContextMenu.Preview>
        <ContextMenu.Items>
          <ChatMenuItems {...menu} />
        </ContextMenu.Items>
      </ContextMenu>
    </Host>
  );
}
