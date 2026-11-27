import { redactSecrets } from "@rakazo/core";

export function nativeTextPrompt(
  prompt: string,
  history: readonly { role: string; content: string; speaker?: string }[],
  secrets: readonly string[],
) {
  return JSON.stringify({
    conversation: history.slice(-16).map(({ role, speaker, content }) => ({
      role,
      ...(speaker ? { speaker } : {}),
      text: redactSecrets(content.slice(-4_000), secrets),
    })),
    message: redactSecrets(prompt, secrets),
  });
}

export function nativeTextInstructions(instructions: string, secrets: readonly string[]) {
  return [
    redactSecrets(instructions, secrets),
    "The input JSON separates the earlier conversation from the current user message. Answer the current message. You can respond in text only. No tools, computer, files, or external actions are available.",
  ].join("\n\n");
}
