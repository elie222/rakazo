ALTER TABLE "access_grants" ADD COLUMN "code" TEXT;
CREATE UNIQUE INDEX "access_grants_code_email_key" ON "access_grants"("code", "email");
