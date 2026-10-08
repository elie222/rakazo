import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/native";
import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import type { MobileMessage } from "../lib/api";

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
  // User messages keep literal Markdown; only explicit URLs and email addresses link.
  return role === "user" ? (
    <LinkifiedText color={tokens.secondaryForeground} linkColor={tokens.link}>
      {text}
    </LinkifiedText>
  ) : (
    <ChatMarkdown palette={tokens} colorScheme={colorScheme} streaming={streaming}>
      {text}
    </ChatMarkdown>
  );
}
