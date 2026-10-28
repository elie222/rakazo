import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/native";
import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { useContext } from "react";
import type { MobileMessage } from "../lib/api";
import { MessageMentionsContext } from "../lib/message-mentions";

export function MessageCaption({
  role,
  text,
  tokens,
  colorScheme,
  streaming,
}: {
  role: MobileMessage["role"];
  text: string;
  tokens: ColorTokens;
  colorScheme: ResolvedAppearance;
  streaming: boolean;
}) {
  const renderMention = useContext(MessageMentionsContext);
  // User messages keep literal Markdown; only explicit URLs and email addresses link.
  // Links stay the bubble's text colour (underlined): link blue is too faint on chatUser.
  return role === "user" ? (
    <LinkifiedText
      color={tokens.chatUserForeground}
      linkColor={tokens.chatUserForeground}
      palette={tokens}
    >
      {text}
    </LinkifiedText>
  ) : (
    <ChatMarkdown
      palette={tokens}
      colorScheme={colorScheme}
      streaming={streaming}
      renderMention={renderMention}
    >
      {text}
    </ChatMarkdown>
  );
}
