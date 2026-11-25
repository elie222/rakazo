ALTER TABLE "access_grants" ADD COLUMN "code" TEXT;
CREATE UNIQUE INDEX "access_grants_email_code_key" ON "access_grants"("email", "code");
