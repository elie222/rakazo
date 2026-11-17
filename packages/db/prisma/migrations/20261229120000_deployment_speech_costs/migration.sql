-- Operator-funded speech has its own allowance and evidence, separate from model credits.
CREATE TABLE speech_allowances (
 "userId" TEXT PRIMARY KEY,
 "limitMicros" BIGINT NOT NULL CHECK ("limitMicros" >= 0),
 "usedMicros" BIGINT NOT NULL DEFAULT 0 CHECK ("usedMicros" >= 0),
 "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE speech_costs (
 id TEXT PRIMARY KEY,
 "userId" TEXT NOT NULL,
 "spaceId" TEXT NOT NULL,
 "callId" TEXT,
 provider TEXT NOT NULL,
 operation TEXT NOT NULL,
 model TEXT NOT NULL,
 unit TEXT NOT NULL,
 units DOUBLE PRECISION,
 "billableUnits" JSONB,
 "observedModel" TEXT,
 "observedUnit" TEXT,
 "accountedMicros" BIGINT NOT NULL CHECK ("accountedMicros" >= 0),
 "confirmationSource" TEXT,
 "confirmationReference" TEXT UNIQUE,
 "reservedMicros" BIGINT NOT NULL CHECK ("reservedMicros" > 0),
 "costMicros" BIGINT,
 "microsPerUnit" DOUBLE PRECISION NOT NULL,
 "pricingSource" TEXT NOT NULL,
 "pricingVersion" TEXT NOT NULL,
 "providerRequestId" TEXT,
 state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'unresolved', 'estimated', 'confirmed')),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX speech_costs_account ON speech_costs ("userId", "createdAt");
CREATE INDEX speech_costs_space ON speech_costs ("spaceId", "createdAt");
CREATE INDEX speech_costs_reconcile ON speech_costs (state, "createdAt");
ALTER TABLE speech_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE speech_costs ENABLE ROW LEVEL SECURITY;
CREATE POLICY speech_allowances_system ON speech_allowances USING ((SELECT app_rls_bypass()));
CREATE POLICY speech_costs_system ON speech_costs USING ((SELECT app_rls_bypass()));
CREATE POLICY speech_allowances_tenant ON speech_allowances FOR SELECT
 USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY speech_costs_tenant ON speech_costs FOR SELECT
 USING ("userId" = NULLIF(current_setting('app.user_id', true), '') AND
 "spaceId" = NULLIF(current_setting('app.space_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON speech_allowances, speech_costs TO rakazo_app;
