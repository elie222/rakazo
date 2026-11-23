-- Numbers each try at connecting a first model, and keeps a sign-in's app and try number
-- with it so whichever process ends the sign-in can report it.
ALTER TABLE "user" ADD COLUMN "modelConnectStarts" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "pendingCreditsConnect" INTEGER;
ALTER TABLE model_oauth_sessions ADD COLUMN surface TEXT, ADD COLUMN "connectNumber" INTEGER;
