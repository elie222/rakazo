import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/native";
import { splitMentionText } from "@rakazo/core";
import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { useContext } from "react";
import { customFontFamily, useCustomSettings } from "../lib/custom-settings";
import {
  MessageMentionsContext,
  OpenPageContext,
  UserMentionsContext,
} from "../lib/message-mentions";
import type { MobileMessage } from "../lib/mobile-types";
import { UserMention } from "./user-mention";

/** A message's conversation font: size, colour (null follows the theme), and family. */
export type MessageChatFont = {
  size: number;
  color: string | null;
  family?: string;
};

/** This account's conversation font, live from the interface settings. */
export function useMessageChatFont(userId?: string): MessageChatFont {
  const customSettings = useCustomSettings(userId ?? "");
  return {
    size: customSettings.font.chat.size,
    color: customSettings.font.chat.color,
    family: customFontFamily(customSettings),
  };
}

export function MessageCaption({
  role,
  received,
  text,
  tokens,
  colorScheme,
  streaming,
  chatFont,
}: {
  role: MobileMessage["role"];
  /** Another person's message sits on the received surface. */
  received?: boolean;
  text: string;
  tokens: ColorTokens;
  colorScheme: ResolvedAppearance;
  streaming: boolean;
  /** The conversation font from the interface settings; unset follows the type scale. */
  chatFont?: MessageChatFont;
}) {
  const renderMention = useContext(MessageMentionsContext);
  const userMentions = useContext(UserMentionsContext);
  const openPage = useContext(OpenPageContext);
  // User messages keep literal Markdown; only explicit URLs, email addresses and page links link.
  // Links stay the bubble's text colour (underlined): link blue is too faint on chatUser.
  const userColor = chatFont?.color ?? (received ? tokens.foreground : tokens.chatUserForeground);
  return role === "user" ? (
    <LinkifiedText
      color={userColor}
      linkColor={userColor}
      palette={tokens}
      fontSize={chatFont?.size}
      fontFamily={chatFont?.family}
      renderText={
        userMentions
          ? (run) =>
              splitMentionText(run, userMentions.targets).map((part, index) =>
                part.target ? (
                  <UserMention
                    key={index}
                    target={part.target}
                    label={part.text.slice(1)}
                    color={userColor}
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
      bodyFontSize={chatFont?.size}
      bodyColor={chatFont?.color ?? undefined}
      bodyFontFamily={chatFont?.family}
    >
      {text}
    </ChatMarkdown>
  );
}
