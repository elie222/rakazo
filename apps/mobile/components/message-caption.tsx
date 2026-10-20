import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/native";
import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import type { MobileMessage } from "../lib/api";

export function MessageCaption({
  role,
  text,
  tokens,
  colorScheme,
  streaming,
  compact = false,
}: {
  role: MobileMessage["role"];
  text: string;
  tokens: ColorTokens;
  colorScheme: ResolvedAppearance;
  streaming: boolean;
  compact?: boolean;
}) {
  // User messages keep literal Markdown; only explicit URLs and email addresses link.
  return role === "user" ? (
    <LinkifiedText color={tokens.secondaryForeground} linkColor={tokens.link} palette={tokens}>
      {text}
    </LinkifiedText>
  ) : (
    <ChatMarkdown
      compact={compact}
      palette={tokens}
      colorScheme={colorScheme}
      streaming={streaming}
    >
      {text}
    </ChatMarkdown>
  );
}
