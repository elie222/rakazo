-- A constant default classifies existing rows and inserts from older API versions as computers.
-- Mobile enrollment is not enabled until all old computer selectors have drained.
ALTER TABLE "user_devices"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'computer',
  ADD CONSTRAINT "user_devices_kind" CHECK ("kind" IN ('computer', 'mobile'));

-- Only changes to the computer set can invalidate an existing owner-computer approval.
DROP TRIGGER user_devices_pair_clears_routine_computer ON user_devices;
CREATE TRIGGER user_devices_pair_clears_routine_computer AFTER INSERT ON user_devices
FOR EACH ROW WHEN (NEW."kind" = 'computer')
EXECUTE FUNCTION clear_routine_computer_on_device_change();

CREATE TRIGGER user_devices_delete_clears_routine_computer AFTER DELETE ON user_devices
FOR EACH ROW WHEN (OLD."kind" = 'computer')
EXECUTE FUNCTION clear_routine_computer_on_device_change();

DROP TRIGGER user_devices_revoke_clears_routine_computer ON user_devices;
CREATE TRIGGER user_devices_revoke_clears_routine_computer AFTER UPDATE OF "revokedAt" ON user_devices
FOR EACH ROW WHEN (
  OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL AND NEW."kind" = 'computer'
)
EXECUTE FUNCTION clear_routine_computer_on_device_change();
