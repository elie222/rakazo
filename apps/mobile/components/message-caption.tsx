import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/native";
import { splitMentionText } from "@rakazo/core";
import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { useContext } from "react";
import type { MobileMessage } from "../lib/api";
import { MessageMentionsContext, UserMentionsContext } from "../lib/message-mentions";
import { UserMention } from "./user-mention";

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
  const userMentions = useContext(UserMentionsContext);
  // User messages keep literal Markdown; only explicit URLs and email addresses link.
  // Links stay the bubble's text colour (underlined): link blue is too faint on chatUser.
  return role === "user" ? (
    <LinkifiedText
      color={tokens.chatUserForeground}
      linkColor={tokens.chatUserForeground}
      palette={tokens}
      renderText={
        userMentions
          ? (run) =>
              splitMentionText(run, userMentions.targets).map((part, index) =>
                part.target ? (
                  <UserMention
                    key={index}
                    target={part.target}
                    label={part.text.slice(1)}
                    color={tokens.chatUserForeground}
                    onOpenBot={userMentions.onOpenBot}
                  />
                ) : (
                  part.text
                ),
              )
          : undefined
      }
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
