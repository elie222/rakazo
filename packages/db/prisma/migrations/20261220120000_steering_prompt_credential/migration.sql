-- A waiting message remembers the API key that wrote its instructions, for the run it starts.
ALTER TABLE "steering_messages" ADD COLUMN "promptCredentialId" TEXT;
