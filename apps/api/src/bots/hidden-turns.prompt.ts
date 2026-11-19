/** The creation intro's hidden prompt. It names only the tools this bot still has. */
export function botIntroPrompt(input: {
  userName: string;
  spaceName: string | null;
  disabledBuiltinTools: readonly string[];
}): string {
  const canAsk = !input.disabledBuiltinTools.includes("ask_user");
  const canUpdate = !input.disabledBuiltinTools.includes("update_bot");
  const byName = input.userName ? " by first name" : "";
  const options =
    "two to four short options that fit your name, anything your description or instructions already say, and what you know about them, never a stock list";
  return [
    [
      "You were just created.",
      input.userName ? `${input.userName} made you.` : undefined,
      input.spaceName ? `Their team space is called "${input.spaceName}".` : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    // The greeting goes in the question itself, so the card stands on its own.
    canAsk
      ? `Call ask_user right away, with no text before it. Its question greets them${byName} in a few words and asks what they want you for, with ${options}. They can also type their own answer.`
      : `Greet them${byName} in a few words and ask in one sentence what they want you for, suggesting ${options}.`,
    "If your profile already makes that clear, say in one line what you will do instead of asking.",
    canUpdate
      ? 'Once you know what you are for, use update_bot to set what is already clear: a one-line description of what you do, your instructions on how you do it, and a short name if yours is still a placeholder like "New Bot". Leave anything vague unset to fill in later as the work becomes clearer, and otherwise keep your name and look.'
      : undefined,
    "Then get started, asking one follow-up only if you cannot start without it.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The card is closed by a marker; the run that follows finishes whatever the call left open. */
export const HANG_UP_PROMPT =
  "The voice call just ended because the user hung up. First call end_call with a short title for the call (leave farewell empty). Then, if anything the user asked for during the call is still unfinished, complete it now as a normal chat reply with full formatting. If nothing is pending, reply with one short sentence.";

export function mcpConnectedPrompt(name: string): string {
  return `The user just connected the MCP server ${JSON.stringify(name)} from its approval card, so its tools are available now. Carry on with what they asked for. If nothing is left to do, confirm in one short sentence.`;
}
