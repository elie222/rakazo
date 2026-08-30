export const BOT_FIELD_LIMITS = {
  name: 80,
  title: 160,
  description: 4_000,
  instructions: 20_000,
} as const;

export interface BotDraft {
  name: string;
  title: string;
  description: string;
  instructions: string;
}

export function validateBotDraft(draft: BotDraft): string | null {
  if (!draft.name.trim()) return "Give your bot a name.";
  if (draft.name.length > BOT_FIELD_LIMITS.name) {
    return `Bot name must be ${BOT_FIELD_LIMITS.name} characters or fewer.`;
  }
  if (draft.title.length > BOT_FIELD_LIMITS.title) {
    return `Bot title must be ${BOT_FIELD_LIMITS.title} characters or fewer.`;
  }
  if (draft.description.length > BOT_FIELD_LIMITS.description) {
    return `Bot description must be ${BOT_FIELD_LIMITS.description} characters or fewer.`;
  }
  if (draft.instructions.length > BOT_FIELD_LIMITS.instructions) {
    return `Bot instructions must be ${BOT_FIELD_LIMITS.instructions} characters or fewer.`;
  }
  return null;
}
