-- AlterTable
ALTER TABLE "bots" ADD COLUMN "hostDeviceId" TEXT;

-- CreateIndex
CREATE INDEX "bots_hostDeviceId_idx" ON "bots"("hostDeviceId");

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_hostDeviceId_fkey" FOREIGN KEY ("hostDeviceId") REFERENCES "user_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
