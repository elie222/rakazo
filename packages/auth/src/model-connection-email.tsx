/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { MODEL_SUBSCRIPTION_NAMES } from "@rakazo/core";
import { Text } from "react-email";
import { Button, emailText, greeting, message } from "./email.js";
import { emailCopy } from "./email-copy/deployment-copy.js";

/** Opens the connect step, through sign-in when the browser has no session. */
export function modelConnectionUrl(webOrigin: string): string {
  const url = new URL("/sign-in", webOrigin);
  url.searchParams.set("next", "/onboarding/model");
  return url.href;
}

export function modelConnectionEmail(
  user: { email: string; name: string },
  links: { webOrigin: string; unsubscribeUrl: string },
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const copy = emailCopy("model-connection", locale);
  const subscriptions = new Intl.ListFormat(locale, { type: "disjunction" }).format(
    MODEL_SUBSCRIPTION_NAMES,
  );
  return message(
    user.email,
    locale,
    copy("subject"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{copy("intro")}</Text>
      <Text>{copy("connect", { subscriptions })}</Text>
      <Button href={modelConnectionUrl(links.webOrigin)}>{copy("button")}</Button>
    </>,
    links.unsubscribeUrl,
  );
}
