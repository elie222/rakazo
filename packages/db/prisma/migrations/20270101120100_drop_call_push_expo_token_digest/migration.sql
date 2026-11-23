-- deferred
DROP TRIGGER call_push_token_digest_sync ON "call_push_devices";
DROP FUNCTION call_push_token_digest_sync();
ALTER TABLE "call_push_devices" DROP COLUMN "expoTokenDigest";
