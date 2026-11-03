-- Synthetic pre-plugin rows. Apply on the previous schema, then migrate and
-- verify these records remain unowned and usable (installId IS NULL).
INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
VALUES ('plugin-upgrade-user', 'Upgrade fixture', 'plugin-upgrade@example.test', false, now(), now());
INSERT INTO "organization" ("id", "name", "slug", "createdAt")
VALUES ('plugin-upgrade-org', 'Upgrade fixture', 'plugin-upgrade-org', now());
INSERT INTO "spaces" ("id", "organizationId", "name", "isDefault", "createdByUserId", "createdAt")
VALUES ('plugin-upgrade-space', 'plugin-upgrade-org', 'General', true, 'plugin-upgrade-user', now());
INSERT INTO "agent_skills" ("id", "spaceId", "userId", "name", "description", "content", "source", "createdAt", "updatedAt")
VALUES ('plugin-upgrade-skill', 'plugin-upgrade-space', 'plugin-upgrade-user', 'legacy-skill', 'Existing user skill', 'Legacy content', 'user', now(), now());
INSERT INTO "mcp_servers" ("id", "spaceId", "userId", "slug", "name", "transport", "endpoint", "createdAt", "updatedAt")
VALUES ('plugin-upgrade-server', 'plugin-upgrade-space', 'plugin-upgrade-user', 'legacy-server', 'Legacy server', 'streamable_http', 'https://tools.example.test/mcp', now(), now());
INSERT INTO "capability_installs" ("id", "spaceId", "userId", "kind", "name", "source", "createdAt")
VALUES ('plugin-upgrade-install', 'plugin-upgrade-space', 'plugin-upgrade-user', 'api', 'Legacy API', 'https://tools.example.test/api', now());
