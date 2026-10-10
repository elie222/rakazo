import * as z from "zod";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
} from "./domain.js";

export const BotTemplateSchema = z.object({
  slug: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH),
  description: z.string().max(BOT_DESCRIPTION_MAX_LENGTH),
  instructions: z.string().trim().min(1).max(BOT_INSTRUCTIONS_MAX_LENGTH),
  featured: z.boolean(),
});
export type BotTemplate = z.infer<typeof BotTemplateSchema>;

export function searchBotTemplates(templates: BotTemplate[], query: string): BotTemplate[] {
  const words = query.toLowerCase().trim().split(/\s+/);
  return templates.filter((template) => {
    const text = `${template.name} ${template.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
