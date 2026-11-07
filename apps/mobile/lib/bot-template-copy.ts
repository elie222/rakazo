import type { BotTemplate } from "@rakazo/contracts";
import { t } from "./i18n";

export type BotTemplateCopy = Pick<BotTemplate, "name" | "summary" | "sample">;

/**
 * Each template's name, summary and sample in the app's language. The English here must match
 * `BOT_TEMPLATES` (a test checks); a template without copy here shows the server's English.
 */
export function botTemplateCopy(template: BotTemplate): BotTemplateCopy {
  switch (template.id) {
    case "morning-briefing":
      return {
        name: t("Morning briefing"),
        summary: t("Your day at a glance, every weekday morning"),
        sample: t(
          "**Thursday**\n\n**Calendar**\n- 10:00 Design review, moved to 11:30\n- 14:00 Call with Dana\n\n**Needs you**\n- Alex asked for the Q4 numbers by noon\n- A contract is waiting for your signature\n\n**Worth knowing**\n- Light rain after 4pm\n- Two stories on the topics you follow",
        ),
      };
    case "inbox-triage":
      return {
        name: t("Inbox triage"),
        summary: t("Sorts new email and drafts the replies"),
        sample: t(
          '**12 new since 8:00**\n\n**Reply needed**\n1. Priya wants to move Friday\'s review. Draft: "Friday works if we start at 2."\n2. Your card expires on the 30th. Draft ready.\n3. Sam asked about the API limits. Draft ready.\n\n**For your information**: a shipping update and a calendar change\n\n**Low priority**: 7 newsletters and notifications',
        ),
      };
    case "pr-reviewer":
      return {
        name: t("PR reviewer"),
        summary: t("Reviews pull requests waiting on you"),
        sample: t(
          "**2 pull requests are waiting on you**\n\n**#482 Add retry to webhook delivery**\n- Retries on 404 too, so a deleted endpoint is retried five times. Retry only 5xx and timeouts?\n- No test for the backoff cap.\n\nSuggested review: request changes.\n\n**#479 Fix date parsing in reports**\nLooks good. Suggested review: approve.",
        ),
      };
    case "topic-watch":
      return {
        name: t("Topic watch"),
        summary: t("A weekly digest of what changed on topics you follow"),
        sample: t(
          "**This week**\n\n**Open-source AI agents**\n- A major release adds scheduled tasks (3 days ago)\n- Two new comparisons; both call memory the main gap\n\n**competitor.example**\n- Pricing: the Team plan went from $20 to $25 per seat\n\nNothing new on battery recycling.",
        ),
      };
    default:
      return template;
  }
}
