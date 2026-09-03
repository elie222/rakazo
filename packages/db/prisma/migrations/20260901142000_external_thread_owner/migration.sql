ALTER TABLE "threads" DROP CONSTRAINT "threads_bot_or_group_chk";

ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId") = 1
);
