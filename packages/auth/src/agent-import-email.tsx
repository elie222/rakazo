/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { AGENT_IMPORT_ASSISTANTS } from "@rakazo/core";
import { Text } from "react-email";
import { Button, emailText, greeting, message } from "./email.js";

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
  const assistants = new Intl.ListFormat(locale, { type: "disjunction" }).format(
    AGENT_IMPORT_ASSISTANTS.map((assistant) => assistant.name),
  );
  return message(
    user.email,
    locale,
    say("Bring your old assistant to Rakazo"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>
        {say(
          "Already set up an assistant in {assistants}? Rakazo can bring over its instructions, memory, skills and routines as a new bot, so you don't start again.",
          { assistants },
        )}
      </Text>
      <Text>
        {say("It works for any other assistant too: send it one prompt and paste its reply.")}
      </Text>
      <Button href={agentImportUrl(links.webOrigin)}>{say("Import an agent")}</Button>
    </>,
    links.unsubscribeUrl,
  );
}
