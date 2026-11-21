/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { Text } from "react-email";
import { Button, emailText, greeting, message } from "./email.js";

/** Opens the app on its first chat, through sign-in when the browser has no session. */
export function firstChatUrl(webOrigin: string): string {
  return new URL("/sign-in", webOrigin).href;
}

export function firstChatEmail(
  user: { email: string; name: string },
  links: { webOrigin: string; unsubscribeUrl: string },
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Your bot is ready"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{say("Your model is connected, so your bot can reply now.")}</Text>
      <Text>
        {say("A good first task: ask it to go through your inbox and tell you what needs a reply.")}
      </Text>
      <Button href={firstChatUrl(links.webOrigin)}>{say("Send a message")}</Button>
    </>,
    links.unsubscribeUrl,
  );
}
