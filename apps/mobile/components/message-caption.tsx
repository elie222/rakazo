import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/native";
import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { typeScale } from "@rakazo/ui-tokens";
import { useContext } from "react";
import { Text } from "react-native";
import type { MobileMessage } from "../lib/api";
import {
  MessageMentionsContext,
  textWithMentions,
  UserMentionsContext,
} from "../lib/message-mentions";
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
  const parts =
    role === "user" && userMentions ? textWithMentions(text, userMentions.targets) : null;
  // User messages keep literal Markdown; only explicit URLs and email addresses link.
  // Links stay the bubble's text colour (underlined): link blue is too faint on chatUser.
  return parts?.some((part) => part.target) ? (
    <Text style={{ color: tokens.chatUserForeground, ...typeScale.body }}>
      {parts.map((part, index) =>
        part.target ? (
          <UserMention
            key={index}
            target={part.target}
            label={part.text.slice(1)}
            color={tokens.chatUserForeground}
            onOpenBot={userMentions!.onOpenBot}
          />
        ) : (
          <LinkifiedText
            key={index}
            color={tokens.chatUserForeground}
            linkColor={tokens.chatUserForeground}
            palette={tokens}
          >
            {part.text}
          </LinkifiedText>
        ),
      )}
    </Text>
  ) : role === "user" ? (
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
