// Kept in a leaf module so bot-secrets.ts can share it without importing bot.ts, which imports
// threads/message-blocks.ts, which imports bot-secrets.ts.
export const AGENT_SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
