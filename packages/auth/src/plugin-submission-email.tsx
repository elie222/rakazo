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

/** A claim proves the claimant reads mail at the app's domain before anyone reviews it. */
export function integrationClaimConfirmEmail(
  email: string,
  url: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Confirm your Rakazo page claim"),
    <>
      <Text>
        <Link href={url} style={linkStyle}>
          {say("Confirm claim")}
        </Link>
      </Text>
      <Text>
        {say("We review every claim once it's confirmed and will email you when it's done.")}
      </Text>
      <Text>
        {say("This link expires in one day. If you did not claim a page, ignore this email.")}
      </Text>
    </>,
  );
}

export function pluginSubmissionAdminEmail(
  to: string,
  submission: { name: string; source: string | null; claim?: string | null; email: string },
  reviewUrl: string,
): Promise<TransactionalEmail> {
  return message(
    to,
    "en",
    submission.claim
      ? `New page claim: ${submission.name}`
      : `New plugin submission: ${submission.name}`,
    <>
      <Text>
        {submission.name} from {submission.email}
      </Text>
      <Text>{submission.source ?? submission.claim}</Text>
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
    claim?: boolean;
  },
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const approved = submission.status === "approved";
  const name = submission.name;
  return message(
    submission.email,
    locale,
    submission.claim
      ? say("Your Rakazo page claim: {name}", { name })
      : approved
        ? say("{name} is in the Rakazo marketplace", { name })
        : say("Your Rakazo plugin submission: {name}", { name }),
    <>
      <Text>
        {submission.claim
          ? approved
            ? say("Your changes to the {name} page are approved.", { name })
            : say("We couldn't approve your changes to the {name} page.", { name })
          : approved
            ? say("{name} is now listed in the Rakazo plugin marketplace.", { name })
            : say("We couldn't list {name} in the Rakazo plugin marketplace.", { name })}
      </Text>
      {submission.reason ? <Text>{submission.reason}</Text> : null}
      <Text>{say("Have any questions? Reply to this email.")}</Text>
    </>,
  );
}
