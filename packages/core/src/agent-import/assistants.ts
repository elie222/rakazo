/**
 * The assistants an import names, in the order they are offered. `home` is the folder a
 * folder-based assistant keeps its files in; one without it writes an export when asked.
 */
export const AGENT_IMPORT_ASSISTANTS = [
  { id: "grok_bot", name: "Grok Bot", home: null },
  { id: "hermes", name: "Hermes", home: "~/.hermes" },
  { id: "openclaw", name: "OpenClaw", home: "~/.openclaw" },
] as const;

export type AgentImportAssistant = (typeof AGENT_IMPORT_ASSISTANTS)[number];
