/** Map an unmodified primary chord to the chat navigation action shared by both shells. */
export function resolveChatNavigationShortcut(event: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): "search" | "new-chat" | null {
  if ((!event.metaKey && !event.ctrlKey) || event.shiftKey || event.altKey) return null;
  switch (event.key.toLowerCase()) {
    case "k":
      return "search";
    case "n":
      return "new-chat";
    default:
      return null;
  }
}
