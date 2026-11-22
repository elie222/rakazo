/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { INVITED_TRIAL_WEEKS } from "@rakazo/contracts";
import { Link, Text } from "react-email";
import { emailText, greeting, linkStyle, message } from "./email.js";
import { emailCopy } from "./email-copy/deployment-copy.js";

export function referralEmail(
  user: { email: string; name: string },
  invitePageUrl: string,
  unsubscribeUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const copy = emailCopy("referral", locale);
  return message(
    user.email,
    locale,
    copy("subject"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>
        {copy("body", { weeks: INVITED_TRIAL_WEEKS })}{" "}
        <Link href={invitePageUrl} style={linkStyle}>
          {copy("link")}
        </Link>{" "}
        {copy("afterLink")}
      </Text>
      <Text>{copy("signature")}</Text>
    </>,
    unsubscribeUrl,
  );
}
