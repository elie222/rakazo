import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/native";
import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { useContext } from "react";
import {
  MessageMentionsContext,
  OpenPageContext,
  UserMentionsContext,
  userMentionRuns,
} from "../lib/message-mentions";
import type { MobileMessage } from "../lib/mobile-types";
import { UserMention } from "./user-mention";

export function MessageCaption({
  role,
  received,
  text,
  tokens,
  colorScheme,
  streaming,
}: {
  role: MobileMessage["role"];
  /** Another person's message sits on the received surface. */
  received?: boolean;
  text: string;
  tokens: ColorTokens;
  colorScheme: ResolvedAppearance;
  streaming: boolean;
}) {
  const renderMention = useContext(MessageMentionsContext);
  const userMentions = useContext(UserMentionsContext);
  const openPage = useContext(OpenPageContext);
  const mentionRuns = userMentions ? userMentionRuns(text, userMentions.targets) : undefined;
  // User messages keep literal Markdown; only explicit URLs, email addresses and page links link.
  // Links stay the bubble's text colour (underlined): link blue is too faint on chatUser.
  return role === "user" ? (
    <LinkifiedText
      color={received ? tokens.foreground : tokens.chatUserForeground}
      linkColor={received ? tokens.foreground : tokens.chatUserForeground}
      palette={tokens}
      renderText={
        userMentions && mentionRuns
          ? (run, start) =>
              mentionRuns(run, start).map((part, index) =>
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
      onOpenPage={openPage}
    >
      {text}
    </LinkifiedText>
  ) : (
    <ChatMarkdown
      palette={tokens}
      colorScheme={colorScheme}
      streaming={streaming}
      renderMention={renderMention}
      onOpenPage={openPage}
    >
      {text}
    </ChatMarkdown>
  );
}
