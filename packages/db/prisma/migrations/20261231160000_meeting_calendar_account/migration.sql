-- Sealed sign-in details for calendars reached with an app password (CalDAV).
ALTER TABLE "meeting_calendar_connections" ADD COLUMN "accountCiphertext" TEXT;
