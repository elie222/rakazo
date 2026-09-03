ALTER TABLE "external_conversations"
ADD COLUMN "participantNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
