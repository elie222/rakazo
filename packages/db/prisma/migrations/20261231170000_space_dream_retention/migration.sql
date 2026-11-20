-- Additive: older releases keep writing spaces without a retention setting.
ALTER TABLE "spaces" ADD COLUMN "dreamRetention" INTEGER;
