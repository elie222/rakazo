-- Host speech for a Mac running the API. Empty macVoice keeps cloud playback.
ALTER TABLE "bots" ADD COLUMN "macVoice" TEXT NOT NULL DEFAULT '';
