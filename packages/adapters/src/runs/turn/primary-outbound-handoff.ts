import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { BOT_MESSAGE_MAX_LENGTH, redactSecrets } from "@rakazo/core";

export function outboundPilotEnrolled(botId: string, environment = process.env) {
  return (
    environment.PRIMARY_RUNTIME_PILOT_OUTBOUND_BOT_IDS?.split(",").some(
      (id) => id.trim() === botId,
    ) ?? false
  );
}

/** Only a directive on the addressed owner's first line can name a recipient. */
export function outboundPilotDirective(text: string, senderName: string) {
  const prefix = `@${senderName} /handoff `;
  if (!senderName || /[\r\n]/.test(senderName) || !text.startsWith(prefix)) return;
  const newline = text.indexOf("\n");
  if (newline === -1) return;
  const recipient = text.slice(prefix.length, newline).trim();
  const prompt = text.slice(newline + 1).trim();
  if (!recipient || !prompt) return;
  return { recipient, prompt };
}

/** No partial output may reach the recipient or appear as an ordinary reply. */
export function collectOutboundPilotText(
  events: AsyncIterable<AgentRuntimeEvent>,
  secrets: readonly string[],
) {
  let text = "";
  let completed = false;
  const add = (chunk: string) => {
    text += chunk;
    if (text.length > BOT_MESSAGE_MAX_LENGTH)
      throw new Error("The handoff draft exceeded the text limit. Nothing was sent.");
  };
  return {
    async *events(): AsyncIterable<AgentRuntimeEvent> {
      for await (const event of events) {
        if (completed) throw new Error("Unexpected output after the handoff draft.");
        if (event.type === "text") add(event.text);
        else if (event.type === "done") {
          if (!text && event.text) add(event.text);
          completed = true;
          yield { type: "done" };
        } else if (event.type === "usage") yield event;
        else throw new Error("Unexpected action while drafting a text handoff.");
      }
    },
    result() {
      const message = redactSecrets(text.trim(), secrets);
      if (!completed || !message || message.length > BOT_MESSAGE_MAX_LENGTH)
        throw new Error("The handoff draft did not complete with valid text. Nothing was sent.");
      return message;
    },
  };
}
