/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { MODEL_CREDIT_GRANT_CENTS } from "@rakazo/core";
import { Link, Text } from "react-email";
import { Button, emailText, greeting, linkStyle, message, withNodes } from "./email.js";

/** Opens the app, through sign-in when the browser has no session. */
export function startChattingUrl(webOrigin: string): string {
  const url = new URL("/sign-in", webOrigin);
  url.searchParams.set("next", "/app");
  return url.href;
}

/** Opens the connect step, through sign-in when the browser has no session. */
export function modelConnectionUrl(webOrigin: string): string {
  const url = new URL("/sign-in", webOrigin);
  url.searchParams.set("next", "/onboarding/model");
  return url.href;
}

/** Sent with the one-time model credit: chat now, or connect a model of their own. */
export function modelConnectionEmail(
  user: { email: string; name: string },
  links: { webOrigin: string; unsubscribeUrl: string },
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const amount = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: MODEL_CREDIT_GRANT_CENTS % 100 ? 2 : 0,
  }).format(MODEL_CREDIT_GRANT_CENTS / 100);
  return message(
    user.email,
    locale,
    say("Credit added to your account"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{say("We added {amount} of credit so you can start chatting now.", { amount })}</Text>
      <Button href={startChattingUrl(links.webOrigin)}>{say("Start chatting")}</Button>
      <Text>
        {withNodes(say("You can also {connect}."), {
          connect: (
            <Link href={modelConnectionUrl(links.webOrigin)} style={linkStyle}>
              {say("connect your own model")}
            </Link>
          ),
        })}
      </Text>
    </>,
    links.unsubscribeUrl,
  );
}
