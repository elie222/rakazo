/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { Link, Text } from "react-email";
import { emailText, greeting, linkStyle, message } from "./email.js";

/** Why saved computer files are due for deletion. */
export type HomeDeletionReason = "plan-ended" | "unused";

export function homeDeletionEmail(
  user: { email: string; name: string },
  deletionDate: Date,
  reason: HomeDeletionReason,
  appUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    deletionDate,
  );
  return message(
    user.email,
    locale,
    say("Your saved computer files will be deleted"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>
        {reason === "plan-ended"
          ? say("Your saved computer files will be deleted on {date} unless you resubscribe.", {
              date,
            })
          : say("Your saved computer files will be deleted on {date} unless you choose a plan.", {
              date,
            })}
      </Text>
      <Text>
        <Link href={appUrl} style={linkStyle}>
          {say("Open Rakazo")}
        </Link>
      </Text>
    </>,
  );
}
