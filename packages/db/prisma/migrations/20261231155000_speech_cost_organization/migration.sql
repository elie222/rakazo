-- Speech allowance is per organization and must keep counting after a Space is deleted.
ALTER TABLE speech_costs ADD COLUMN "organizationId" TEXT;
UPDATE speech_costs AS c SET "organizationId" = s."organizationId"
FROM spaces AS s WHERE s.id = c."spaceId";
CREATE INDEX speech_costs_organization ON speech_costs ("organizationId", "createdAt");
