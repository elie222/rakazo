/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { MODEL_SUBSCRIPTION_NAMES } from "@rakazo/core";
import { Text } from "react-email";
import { Button, emailText, greeting, message } from "./email.js";

// English only until its translations land; wrap the copy in `say` with them.
const LOCALE = "en";

/** Opens the connect step, through sign-in when the browser has no session. */
export function modelConnectionUrl(webOrigin: string): string {
  const url = new URL("/sign-in", webOrigin);
  url.searchParams.set("next", "/onboarding/model");
  return url.href;
}

export function modelConnectionEmail(
  user: { email: string; name: string },
  links: { webOrigin: string; unsubscribeUrl: string },
): Promise<TransactionalEmail> {
  const subscriptions = new Intl.ListFormat(LOCALE, { type: "disjunction" }).format(
    MODEL_SUBSCRIPTION_NAMES,
  );
  return message(
    user.email,
    LOCALE,
    "Connect a model to start using Rakazo",
    <>
      <Text>{greeting(emailText(LOCALE), user.name)}</Text>
      <Text>
        Your Rakazo plan has started, but your bots can't reply until a model is connected.
      </Text>
      <Text>Sign in with your {subscriptions} subscription, or paste an API key.</Text>
      <Button href={modelConnectionUrl(links.webOrigin)}>Connect a model</Button>
    </>,
    links.unsubscribeUrl,
  );
}
