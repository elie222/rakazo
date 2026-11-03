-- The session that paired a computer. Ending that session revokes the computer.
ALTER TABLE "user_devices" ADD COLUMN "sessionId" TEXT;
