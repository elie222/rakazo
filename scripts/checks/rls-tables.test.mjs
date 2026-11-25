// Row-level security is the boundary that keeps one Space's content out of another's, and the
// migrations set it up by hand, several of them through a FOREACH/EXECUTE format loop that the
// SQL alone does not spell out. Adding a table, or dropping a policy, changes what the app can
// read across Spaces, so it has to be a decision someone sees rather than a line in a migration
// nobody re-reads. This holds the roll call of protected tables, and the two tables kept
// append-only by an explicit revoke, to what the migrations actually do.
//
// It reads the migration SQL as text because the migrations are the record of these grants; the
// schema alone does not say which tables are protected, and a live database is not available in
// `pnpm checks`.
//
// What it does not check, so nobody reads more into a pass than it gives: it does not read the
// body of a policy, so a policy that stops scoping by Space still passes, and it does not decide
// that every Space-owned table ought to be protected. Those need a judgement about the product or
// a SQL engine, not a text comparison, and a guess at either would be worse than the gap.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = path.join(root, "packages/db/prisma/migrations");

/**
 * Every table the migrations put behind row-level security. Add a table here, with the migration
 * that protects it, when a new Space-owned table is added; removing one means deciding that its
 * rows are no longer isolated.
 */
const PROTECTED = [
  "action_approval_rules",
  "agent_imports",
  "agent_secrets",
  "agent_skill_spaces",
  "agent_skills",
  "artifacts",
  "audit_events",
  "billing_audit_events",
  "boards",
  "bot_email_messages",
  "bot_email_sends",
  "bot_mcp_servers",
  "bot_secrets",
  "bots",
  "call_push_devices",
  "capability_install_spaces",
  "computer_allowance_grants",
  "computer_home_versions",
  "computer_runs",
  "computers",
  "connections",
  "email_sends",
  "events",
  "external_conversations",
  "external_messages",
  "feedback_reports",
  "home_deletion_notices",
  "mcp_oauth_sessions",
  "mcp_server_spaces",
  "mcp_servers",
  "media_charges",
  "meeting_allowance_uses",
  "meeting_calendar_authorizations",
  "meeting_calendar_bookings",
  "meeting_calendar_connections",
  "meeting_calendar_rules",
  "meeting_sessions",
  "memory_documents",
  "memory_revisions",
  "messages",
  "messaging_identities",
  "messaging_install_sessions",
  "messaging_installations",
  "messaging_outbound",
  "model_oauth_sessions",
  "native_calendar_requests",
  "page_comments",
  "page_grants",
  "page_images",
  "page_reader_states",
  "page_revision_requests",
  "page_versions",
  "pages",
  "payment_wallets",
  "payments",
  "pruned_message_nonces",
  "purchases",
  "push_registrations",
  "routines",
  "runs",
  "scratchpad_items",
  "secrets",
  "security_events",
  "space_model_role_choices",
  "space_setting_overrides",
  "speech_costs",
  "spending_limits",
  "steering_messages",
  "tasks",
  "taught_skills",
  "thread_reads",
  "threads",
  "ticket_comments",
  "tickets",
  "trusted_link_sites",
  "usage_records",
  "user_action_approval_rules",
  "user_action_auto_review_preferences",
  "user_model_credentials",
  "user_model_preferences",
  "user_model_role_choices",
  "user_voice_credentials",
  "user_voice_preferences",
  "vault_credential_bots",
  "vault_credential_limits",
  "vault_credentials",
  "work_activity_start_tokens",
  "work_activity_tokens",
];

function migrationFiles() {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(migrationsDir, entry.name, "migration.sql"))
    .filter((file) => {
      try {
        readFileSync(file);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * A loop that names its tables in an array and runs the statement through `EXECUTE format`
 * protects each name in that array, so the array is part of the answer.
 */
function arrayTables(sql, statement) {
  const names = [];
  for (const block of sql.matchAll(
    /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([^\]]*)\]([\s\S]*?)END LOOP/g,
  )) {
    if (!statement.test(block[2])) continue;
    for (const name of block[1].matchAll(/'([A-Za-z0-9_]+)'/g)) names.push(name[1]);
  }
  return names;
}

function protectedTables() {
  const names = new Set();
  for (const file of migrationFiles()) {
    const sql = readFileSync(file, "utf8");
    for (const match of sql.matchAll(
      /ALTER TABLE "?([A-Za-z0-9_]+)"?\s+ENABLE ROW LEVEL SECURITY/g,
    ))
      names.add(match[1]);
    for (const name of arrayTables(sql, /ENABLE ROW LEVEL SECURITY/)) names.add(name);
    // A table dropped later is not protected any more, so it leaves the roll call.
    for (const match of sql.matchAll(/DROP TABLE (?:IF EXISTS )?"?([A-Za-z0-9_]+)"?/g))
      names.delete(match[1]);
  }
  return [...names].sort();
}

/** The tables kept append-only by withdrawing a privilege the runtime role would otherwise hold. */
const APPEND_ONLY = ["_prisma_migrations", "security_events"];

const ALL_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];

/** The privileges a `GRANT` or `REVOKE` statement names, expanded. */
function privilegesOf(spec) {
  const named = spec.toUpperCase().replace(/\s+/g, " ").trim();
  if (named === "ALL" || named === "ALL PRIVILEGES") return ALL_PRIVILEGES;
  return named
    .split(",")
    .map((privilege) => privilege.trim())
    .filter(Boolean);
}

/**
 * Which privileges each table has withdrawn, in the order migrations apply. A `GRANT` puts a
 * privilege back, so a revoke naming the right verb but the wrong privilege does not make a table
 * append-only: what has to stay gone is the privilege that would rewrite a row.
 */
function withdrawnPrivileges(tables) {
  const withdrawn = new Map(tables.map((table) => [table, new Set()]));
  const apply = (verb, privileges, targets) => {
    for (const table of targets)
      for (const privilege of privileges) {
        if (verb === "REVOKE") withdrawn.get(table).add(privilege);
        else withdrawn.get(table).delete(privilege);
      }
  };
  for (const file of migrationFiles()) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const statement = line.trim();
      const onTable = /^(GRANT|REVOKE)\s+(.+?)\s+ON\s+TABLE\s+"([A-Za-z0-9_]+)"/i.exec(statement);
      if (onTable) {
        apply(
          onTable[1].toUpperCase(),
          privilegesOf(onTable[2]),
          tables.filter((table) => table === onTable[3]),
        );
        continue;
      }
      // `GRANT ... ON ALL TABLES IN SCHEMA public` reaches every table, including these.
      const onAll = /^(GRANT|REVOKE)\s+(.+?)\s+ON\s+ALL\s+TABLES\b/i.exec(statement);
      if (onAll) apply(onAll[1].toUpperCase(), privilegesOf(onAll[2]), tables);
    }
  }
  return withdrawn;
}

test("the migrations protect exactly the tables this check names", () => {
  assert.deepEqual(
    protectedTables(),
    PROTECTED,
    "a protected table changed: update PROTECTED in this check with the migration that did it",
  );
});

test("the append-only tables keep the revoke that makes them append-only", () => {
  const withdrawn = withdrawnPrivileges(APPEND_ONLY);
  // A log is appended to and never rewritten, so rewriting `security_events` stays withdrawn.
  assert.ok(
    withdrawn.get("security_events").has("UPDATE"),
    "security_events must stay unrewritable",
  );
  assert.deepEqual(
    ALL_PRIVILEGES.filter((privilege) => !withdrawn.get("_prisma_migrations").has(privilege)),
    [],
    "_prisma_migrations must stay closed to the app role",
  );
});
