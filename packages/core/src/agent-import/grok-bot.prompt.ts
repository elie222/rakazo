import { GROK_BOT_EXPORT_FORMAT } from "./grok-bot.js";

/**
 * Grok Bot has no export button, so one Bot writes every Bot's setup, asking the others for
 * their memory. Model-facing text pasted into another product, so it stays in English. Keep its
 * fields in sync with `readBot`.
 */
export const GROK_BOT_EXPORT_PROMPT = `I am moving my Bots to another assistant app and need a complete, machine-readable copy of every Bot in this workspace, not only you. Do not change, pause or delete anything.

1. List every Bot here, yourself included, and ask me which to include before you start. Include all of them unless I say otherwise.
2. Read each Bot's setup from where it is stored (its profile, settings, skills and routines), not from memory, wherever you can read it. Bots usually keep these as files on this computer.
3. Collect memory. Search your own memory with many varied queries (about me, people, projects, systems, decisions, each recent month) and copy every fact word for word. Ask each other Bot you include, by message, to do the same and send you its memories and facts about me word for word. Wait a reasonable time; do not stop for a Bot that does not answer, and tell me which ones did not.
4. Write one JSON file per Bot, named grok-bot-export-<bot name>.json (lowercase, spaces as hyphens), each a whole document in exactly this shape with that one Bot in "bots". Put all the files in one .zip and attach it to your reply. If you cannot attach files, reply with each document in its own \`\`\`json code block.

{
  "format": "${GROK_BOT_EXPORT_FORMAT}",
  "version": 1,
  "bots": [
    {
      "export_id": "the Bot's ID if you can read it, otherwise a unique identifier; repeat it in every split part",
      "name": "the Bot's name",
      "title": "its job title, or empty",
      "description": "one line about what it does, or empty",
      "instructions": "its full role, job description and standing rules, word for word where you can",
      "memories": ["one thing it remembers about the work per string"],
      "user_facts": ["one fact it knows about me (name, time zone, preferences) per string"],
      "skills": [
        {"name": "skill name", "description": "when to use it",
         "instructions": "the COMPLETE skill text: every step, rule and output format, word for word"}
      ],
      "routines": [
        {"name": "routine name",
         "instruction": "the COMPLETE instruction the routine runs, word for word",
         "trigger": "schedule | slack | github | linear | sentry | pagerduty | email | webhook | other",
         "schedule_cron": "5-field cron in the routine's time zone, e.g. 0 8 * * 1-5 (empty when not on a schedule)",
         "schedule_text": "when it runs, in words",
         "timezone": "IANA time zone, e.g. America/New_York",
         "skills": ["names of skills this routine uses"],
         "trigger_details": "for other triggers: channel, repository, phrase, senders and so on"}
      ],
      "apps": [{"name": "connected app or MCP server", "mcp_url": "its remote MCP URL, or empty"}]
    }
  ]
}

Rules:
- Include every routine a Bot owns, paused ones too, and every skill enabled for it, with full text rather than summaries. Leave out built-in skills.
- If you cannot read something, leave it out and tell me what you left out. Never guess or fill it in from memory.
- Never include passwords, API keys, tokens, webhook secrets, cookies or card numbers.
- Output valid JSON only, with no comments.
- If one Bot is too long for one file, split it into several files with the same export_id and name. Keep every skill and routine complete in one part; never split an individual skill or routine.
`;
