ALTER TABLE "external_conversations"
  ADD COLUMN "teamChatAmbientEnabled" BOOLEAN,
  ADD COLUMN "teamChatRules" TEXT,
  ADD COLUMN "automatedSenderPolicies" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "external_messages"
  ADD COLUMN "senderIsBot" BOOLEAN NOT NULL DEFAULT false;
