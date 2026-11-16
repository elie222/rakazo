/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { Text } from "react-email";
import { Button, emailText, FinePrint, message } from "./email.js";

export function organizationInvitationEmail(
  to: string,
  invitation: { organizationName: string; inviterName: string; url: string },
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const values = {
    inviter: invitation.inviterName,
    organization: invitation.organizationName,
  };
  return message(
    to,
    locale,
    say("{inviter} invited you to {organization} on Rakazo", values),
    <>
      <Text>{say("{inviter} invited you to join {organization} on Rakazo.", values)}</Text>
      <Button href={invitation.url}>{say("Join {organization}", values)}</Button>
      <FinePrint>
        {say("This invitation expires in 7 days. Sign in with this email address to accept it.")}
      </FinePrint>
    </>,
  );
}
