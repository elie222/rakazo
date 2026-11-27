import type { AiDataUse, PageDetail } from "@rakazo/contracts";
import { ensureAiDataConsent } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import { allowPromptedAiConsent, rpc } from "../api/api";
import { askPage } from "../api/api-live";
import { promptAiConsent } from "../settings/ai-consent";

const ASK_USES: AiDataUse[] = ["model", "memory"];

/**
 * A page's question to its bot, answered with the text of the bot's reply; null when there is
 * none. The question is a message in the chat, so its AI data sharing is confirmed first.
 */
export async function askPageBot(
  page: Pick<PageDetail, "id" | "botId" | "groupId">,
  text: string,
  signal: AbortSignal,
): Promise<string | null> {
  const chat = page.groupId ? { groupId: page.groupId } : page.botId ? { botId: page.botId } : null;
  if (!chat) return null;
  const answer = await bestEffort(
    "page ask",
    (async () => {
      await ensureAiDataConsent({
        uses: ASK_USES,
        status: () => rpc("aiConsent/status", { ...chat, uses: ASK_USES }),
        prompt: promptAiConsent,
        allow: (input) => allowPromptedAiConsent(input),
      });
      return askPage(page.id, text, signal);
    })(),
  );
  return answer ?? null;
}
