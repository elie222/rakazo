/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { Link, Text } from "react-email";
import { emailText, linkStyle, message } from "./email.js";

// Anyone can submit with any address, so the submitter's copy repeats nothing they typed.
export function pluginSubmissionReceivedEmail(
  email: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("We received your Rakazo plugin"),
    <>
      <Text>{say("Thanks for submitting a plugin to the Rakazo marketplace.")}</Text>
      <Text>{say("We review every submission and will email you when it's done.")}</Text>
      <Text>{say("If you did not submit a plugin, ignore this email.")}</Text>
    </>,
  );
}

export function pluginSubmissionAdminEmail(
  to: string,
  submission: { name: string; source: string; email: string },
  reviewUrl: string,
): Promise<TransactionalEmail> {
  return message(
    to,
    "en",
    `New plugin submission: ${submission.name}`,
    <>
      <Text>
        {submission.name} from {submission.email}
      </Text>
      <Text>{submission.source}</Text>
      <Text>
        <Link href={reviewUrl} style={linkStyle}>
          Review
        </Link>
      </Text>
    </>,
  );
}

export function pluginSubmissionReviewedEmail(
  submission: {
    email: string;
    name: string;
    status: "approved" | "rejected";
    reason: string | null;
  },
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const approved = submission.status === "approved";
  const name = submission.name;
  return message(
    submission.email,
    locale,
    approved
      ? say("{name} is in the Rakazo marketplace", { name })
      : say("Your Rakazo plugin submission: {name}", { name }),
    <>
      <Text>
        {approved
          ? say("{name} is now listed in the Rakazo plugin marketplace.", { name })
          : say("We couldn't list {name} in the Rakazo plugin marketplace.", { name })}
      </Text>
      {submission.reason ? <Text>{submission.reason}</Text> : null}
      <Text>{say("Have any questions? Reply to this email.")}</Text>
    </>,
  );
}
