/** Non-secret routing for the Google Tasks Inbox → Slack #tasks mirror lane. */
export const GTASKS_SLACK_LANE = "gtasks-slack-inbox" as const;

export const GTASKS_SLACK_ROUTING = {
  /** Slack #tasks channel (informational mirror destination). */
  slackChannelId: "C0BQRCBPD51",
  /** Composio toolkit slugs used by the Plugins connection model. */
  composioProviders: {
    googleTasks: "GOOGLETASKS",
    slack: "SLACK",
  },
  /** Composio tool slugs invoked by the mirror port (no live calls in tests). */
  composioTools: {
    listTaskLists: "GOOGLETASKS_LIST_TASK_LISTS",
    listTasks: "GOOGLETASKS_LIST_TASKS",
    postMessage: "SLACK_CHAT_POST_MESSAGE",
    updateMessage: "SLACK_UPDATES_A_SLACK_MESSAGE",
  },
  /** Default Google Tasks list title treated as the Inbox lane source. */
  inboxListTitle: "My Tasks",
} as const;
