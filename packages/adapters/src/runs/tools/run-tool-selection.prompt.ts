/** Model-facing reasons for a built-in tool this run was not offered, by why it was dropped. */
export function groupMessageBotUnavailableReason(handoffOffered: boolean): string {
  return handoffOffered
    ? "message_bot is not available in group threads. Use handoff_to_bot with the group_id and the member's bot_id instead."
    : "message_bot is not available in group threads.";
}

export function createdRunToolUnavailableReason(name: string): string {
  return `${name} is not available until the user says what this bot is for. Use ask_user.`;
}

export function backgroundRunToolUnavailableReason(name: string): string {
  return `${name} is not available in a background run. Report through ticket_comment instead.`;
}

export function disabledBuiltinToolUnavailableReason(name: string): string {
  return `${name} is turned off for this bot.`;
}
