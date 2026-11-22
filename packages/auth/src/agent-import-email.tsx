/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { AGENT_IMPORT_ASSISTANTS } from "@rakazo/core";
import { Text } from "react-email";
import { Button, emailText, greeting, message } from "./email.js";
import { emailCopy } from "./email-copy/deployment-copy.js";

/** Opens the agent import, through sign-in when the browser has no session. */
export function agentImportUrl(webOrigin: string): string {
  const url = new URL("/sign-in", webOrigin);
  url.searchParams.set("next", "/app?import");
  return url.href;
}

export function agentImportEmail(
  user: { email: string; name: string },
  links: { webOrigin: string; unsubscribeUrl: string },
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const copy = emailCopy("agent-import", locale);
  const assistants = new Intl.ListFormat(locale, { type: "disjunction" }).format(
    AGENT_IMPORT_ASSISTANTS.map((assistant) => assistant.name),
  );
  return message(
    user.email,
    locale,
    copy("subject"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{copy("intro", { assistants })}</Text>
      <Text>{copy("other")}</Text>
      <Button href={agentImportUrl(links.webOrigin)}>{copy("button")}</Button>
    </>,
    links.unsubscribeUrl,
  );
}
