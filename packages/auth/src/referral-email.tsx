/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { Link, Text } from "react-email";
import { emailText, greeting, linkStyle, message } from "./email.js";

export function referralEmail(
  user: { email: string; name: string },
  invitePageUrl: string,
  unsubscribeUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Invite a friend"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>
        {say(
          "Invite a friend to Rakazo and earn a free month when they start a qualifying subscription with a new card.",
        )}{" "}
        <Link href={invitePageUrl} style={linkStyle}>
          {say("Open Rakazo")}
        </Link>{" "}
        {say("and choose Invite friends for your link.")}
      </Text>
      <Text>{say("Have any questions? Just reply to this email.")}</Text>
      <Text>
        {say("If you're enjoying Rakazo,")}{" "}
        <Link href="https://github.com/elie222/rakazo" style={linkStyle}>
          {say("give us a star on GitHub")}
        </Link>
        .
      </Text>
      <Text>Elie</Text>
    </>,
    unsubscribeUrl,
  );
}
