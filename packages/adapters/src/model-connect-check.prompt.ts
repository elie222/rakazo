import type { Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** The smallest agent request: a tool makes a model without tool support fail here, not on its first run. */
export const MODEL_CONNECT_CHECK_CONTEXT: Context = {
  systemPrompt: "Reply with OK.",
  messages: [{ role: "user", content: "OK?", timestamp: 0 }],
  tools: [{ name: "noop", description: "Does nothing.", parameters: Type.Object({}) }],
};
