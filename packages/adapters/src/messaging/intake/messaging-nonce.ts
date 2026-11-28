/** The user message one inbound chat-app message becomes, so a second delivery of it is a no-op. */
export function messagingMessageClientNonce(provider: string, handle: string): string {
  return `messaging:${provider}:${handle}`;
}
