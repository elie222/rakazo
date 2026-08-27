export interface BotProfileFields {
  name: string;
  title: string;
  description: string;
  instructions: string;
  color: string;
  sectionId: string | null;
  agentSkillIds: string[] | null;
}

export function botProfileUpdate(fields: BotProfileFields): BotProfileFields {
  return { ...fields };
}
