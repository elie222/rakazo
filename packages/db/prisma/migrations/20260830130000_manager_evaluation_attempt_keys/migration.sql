-- Preserve forward compatibility for databases that already applied the
-- initial ManagerEvaluation migration: one planning identity can have bounded
-- sequential attempts, but no duplicate attempt number.
DROP INDEX "manager_evaluations_planningKey_key";
CREATE UNIQUE INDEX "manager_evaluations_planningKey_attempt_key"
  ON "manager_evaluations"("planningKey", "attempt");
