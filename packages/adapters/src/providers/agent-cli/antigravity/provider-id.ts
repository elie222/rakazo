/**
 * Google's official Antigravity CLI (`agy`) on the server's own host, signed in by the operator.
 * Kept apart from the descriptor so the deployment model can name it without loading anything
 * else.
 */
export const ANTIGRAVITY_CLI_PROVIDER_ID = "antigravity-cli";

/** What the deployment's host credentials are, for the existing "Uses this server's own …" line. */
export const ANTIGRAVITY_CLI_CREDENTIAL_SOURCE = "CLI";
