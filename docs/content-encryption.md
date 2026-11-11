# Content encryption at rest

Rakazo encrypts user content before it reaches PostgreSQL or the artifact
directory, so a copied database dump, backup or disk does not reveal it.

## What is encrypted

| Data                                                                                                                                                                                                                         | Where                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Chat messages                                                                                                                                                                                                                | `messages.blocks`                                                             |
| Thread events (they repeat message content)                                                                                                                                                                                  | `events.payload`                                                              |
| Compacted history summaries                                                                                                                                                                                                  | `threads.historyCompactionSummary`                                            |
| Memory documents and their revisions                                                                                                                                                                                         | `memory_documents.content`, `memory_revisions.content`                        |
| Uploaded and generated files                                                                                                                                                                                                 | `DATA_DIR/artifacts/<space>/<file>`                                           |
| Bot computer homes kept in [object storage](./self-host-storage.md#bot-homes-in-object-storage) (always, whatever `CONTENT_ENCRYPTION` says)                                                                                 | `homes/<id>/<revision>` in the bucket                                         |
| Vault items (logins, cards, contacts, API credentials and command variables) that `migrate` moved, and later saves to the same vault while encryption is on and `SECRET_STORE` is the default ([vault items](#how-it-works)) | `vault_credentials.ciphertext`                                                |
| Other credentials, and vault items not yet moved (unchanged scheme)                                                                                                                                                          | `secrets`, `bot_secrets`, `integration_provider_configs`, `vault_credentials` |

Not yet encrypted, planned next: external conversation messages, outbound
messaging bodies, steering messages, ticket comments, agent skills, taught
skill playbooks and recordings, and bot instruction history. Names and other
metadata stay plaintext: bot, group, file and thread names, routine prompts,
memory paths, timestamps, ids, block kinds and statuses.

## Turning it off

`CONTENT_ENCRYPTION=off` stores new content and files in plaintext; `on` (the
default for server installs) encrypts them. Reads decrypt existing ciphertext
in both modes, and search matches plaintext, encrypted and mixed rows. A
message rewritten while off drops its search tokens, so it matches its new
text. `content-encryption decrypt` converts what is still encrypted, and
`content-encryption migrate` encrypts everything after switching back on
(`migrate`, `rotate` and `reencrypt` always encrypt, whatever the setting).
Defaults and commands are in [self-hosting](./self-host-storage.md#content-encryption).

`content-encryption export [--space <id>] [--thread <id>] [--bot <id>] [--output <file>]`
writes decrypted threads (with their summary), messages, memory documents and
revisions as JSON lines, to stdout or to a new owner-only file. It is
read-only and runs across spaces.

## How it works

- **Envelope encryption.** Each space has a random 256-bit data key, stored in
  `space_keys` wrapped (AES-256-GCM) by a master key. New content uses the
  space's newest key version; every version still decrypts.
- **Master keys.** The default key provider reads them from the environment.
  `ENCRYPTION_MASTER_KEYS="k2:<key>,k1:<key>"` lists them, active first; each
  key is 32 bytes as 64 hex characters or base64 (`openssl rand -hex 32`).
  Without it, a master key derived from `ENCRYPTION_KEY` (id `env`) is used. The
  derived key always stays available for unwrapping, so existing keys keep
  working after you add explicit ones.
- **Ciphertext.** `rkz1:<space key id>:<base64url(iv | ciphertext | tag)>`,
  AES-256-GCM with a fresh IV per value. The authenticated data binds the
  table, column, row id and space, so a value copied to another row, column or
  space fails to decrypt instead of being shown in the wrong place.
- **JSON columns.** Each message block (and each event payload) is stored as
  `{ ...queryable scalars, "$sealed": "rkz1:…" }`. The sealed copy is the full
  original and the only one read back. The scalars kept beside it are the ones
  queries filter on: block `kind`, `status`, `channelId`, `serverId` and
  `artifactId`; payload `messageId`, `notice`, `state`, `updatedAt` and
  `streaming`.
- **Artifacts.** A header naming the key, then 64 KiB AES-GCM segments. Nonces
  count segments and each segment authenticates the header, space, file id and
  whether it is last, so truncation, reordering and splicing all fail. Files
  are encrypted and decrypted as streams.
- **Data access.** `createDb` returns a Prisma client extension that encrypts
  writes and decrypts reads for the columns above, including nested
  `include`/`select`. Nested writes into these models are rejected, so content
  cannot reach the database through a path that skips encryption. Raw SQL
  reads use `contentEncryptionOf(prisma).openRows`.
- **Vault items.** Each vault has its own key in `space_keys`: `user:<member id>`
  for a member's account vault, `vault:<space id>` for a Space's own vault.
  The authenticated data binds the table, column, row id, member and vault, so
  a value copied to another item, member or vault fails to decrypt. Only
  `migrate` creates a vault's key. Until it has, saves in that vault keep the
  format sealed with `ENCRYPTION_KEY` that earlier releases read; once it has,
  saves use the key while `CONTENT_ENCRYPTION` is on and `SECRET_STORE` is the
  default (with [Infisical](./infisical-secrets.md) they stay in Infisical).
  With Infisical, `migrate` also moves items still stored locally to their
  vault keys; run `secrets:infisical` first to move them to Infisical instead.
  `migrate` moves items whatever `CONTENT_ENCRYPTION` says, and they stay under
  the key if it is turned off later, until saved again or `decrypt` runs.
  Both formats always read. Deleting a member or a Space deletes its vault
  key along with its vault items.
- **Rollout tolerance.** Rows and files written before encryption read
  unchanged, so the application can run while `migrate` works through them.

### Search

Postgres full-text search cannot read ciphertext. Messages carry a
`searchTokens` integer array with a GIN index: keyed HMACs (per space) of each
normalized word in the conversational text, plus word prefixes of 2 to 10
characters from every string in the message. Agent history search matches
whole words, as before. Space search matches word prefixes, then decrypts the
candidates and applies its usual filter. Rows not yet migrated keep matching
through the old full-text and substring predicates.

Tradeoffs:

- Someone with the database but not the keys can see which encrypted messages
  in the same space share a word or prefix, and how often tokens repeat. They
  cannot recover the words without the space key.
- Space search no longer finds text in the middle of a word ("elican" no longer
  matches "pelican") once a row is encrypted. Queries of single characters scan
  the 200 most recent messages instead of the index.
- Tokens are 32-bit, so unrelated words occasionally collide; those candidates
  are discarded after decryption.
- Space search checks at most 500 index candidates per query, newest first, so
  a phrase whose words are common may need a more specific query to reach
  older messages. Agent history search pages through cursors instead.

## Threat model

Protects against:

- A stolen or leaked database dump, replica, backup or disk image, without the
  master keys.
- A stolen copy of the artifact directory, without the master keys.
- Someone with database write access moving ciphertext between rows, columns
  or spaces: the moved value fails to decrypt.
- Deleted spaces and members: deleting a space deletes its keys, its own
  vault's included, and deleting a member deletes their account vault's key
  (database triggers), so ciphertext left in unvacuumed pages, WAL or orphaned
  files is unreadable. Items in a Space's own vault from a member who is
  deleted, leaves or is removed stay under that Space's vault key until the
  Space is deleted. Vault items still in
  the `ENCRYPTION_KEY` format, and copies left from before `migrate` moved them,
  read with that key instead.

Does not protect against:

- A compromised running API or worker. The process holds the master keys and
  caches unwrapped space keys; whoever controls it can decrypt everything it
  can read.
- Anyone who has both the database and the master keys. With the default
  provider, the master keys live in the same environment as `DATABASE_URL`;
  keep backups and environment secrets apart, or put the master keys in a key
  management service (see below).
- Backups taken before a space was deleted or a master key was rotated: they
  hold the old wrapped keys, which the old master key still unwraps. Retire an
  old master key only after every backup made with it has expired.
- Metadata: names, ids, timestamps, sizes, block kinds and the search-token
  patterns described above.

## Rollout

1. **Back up first.** Take a PostgreSQL backup and a copy of `DATA_DIR`, and
   store `ENCRYPTION_KEY` (and `ENCRYPTION_MASTER_KEYS`, if set) separately.
   Encrypted content is unreadable without them: losing the keys loses the
   content.
2. Optionally set `ENCRYPTION_MASTER_KEYS` on the API and worker so the master
   key is independent of `ENCRYPTION_KEY`.
3. Deploy. Migrations add `space_keys` and the search index; new content is
   encrypted from the first request.
4. Once the previous release has stopped (its worker runs until its jobs
   finish), encrypt existing content, then check nothing is left. Vault items
   move to their keys only here, since the previous release cannot read them
   afterwards:

   ```bash
   pnpm --filter @rakazo/api content-encryption migrate --dry-run
   pnpm --filter @rakazo/api content-encryption migrate
   pnpm --filter @rakazo/api content-encryption status
   ```

   `migrate` works in batches, locks each batch while rewriting it, and can be
   interrupted and rerun. It also upgrades credentials still stored in the
   pre-v2 format (no record binding) to the current format, and moves vault
   items to the keys above, each with a compare-and-set, keeping its value
   until the new one is written and checked; an item it cannot read is left
   as it was and reported as failed, with the step that failed and the kind of
   error (never its value or a key). `--dry-run` reads every item but creates
   no key. A vault key is created only while its member or Space exists, so a
   deletion during `migrate` leaves no key behind. Run it where `DATA_DIR` is
   mounted so artifacts are encrypted too.

   The `vault_credentials` line of `status` counts every vault item not yet
   under a vault key, apart from items in Infisical. The count does not always
   reach zero. It includes:
   - items saved while `migrate` ran, which can keep the older format;
   - vaults first used after `migrate` ran, such as a new member's;
   - items saved while `CONTENT_ENCRYPTION=off`;
   - items `migrate` reported as failed, which stay counted until they are
     fixed or deleted.

   Rerun `migrate` until its `vault items:` line reports 0 rewritten and
   0 changed concurrently, then stop. What `status` still counts are the
   items that run reported as failed in the older format. The count grows
   again as new vaults are first used, and as items are saved with encryption
   off. The next `migrate` moves those.

To roll back to an earlier release, set `CONTENT_ENCRYPTION=off` on the API and
worker (so new vault saves use the `ENCRYPTION_KEY` format again), then run
`content-encryption decrypt`. It writes content and vault items back to the
formats older releases read; releases before content encryption cannot read
ciphertext, and releases before this one cannot read vault items under a vault
key. An item edited while it runs can keep its vault key, so rerun it until it
reports none changed concurrently. After rolling back to a release that has content encryption, turn
`CONTENT_ENCRYPTION` back on there and run its `migrate` to encrypt content
again; vault items stay in the `ENCRYPTION_KEY` format on that release. Vault
keys stay after `decrypt`, so when deploying this release again later, keep
`CONTENT_ENCRYPTION=off` until the previous release has stopped, then turn it on
and run `migrate`.

## Rotation

Rotate the master key:

1. Generate a key and put it first: `ENCRYPTION_MASTER_KEYS="k2:<new>,k1:<old>"`
   (omit `k1` if you never set one; the derived `env` key stays available).
2. Deploy the API and worker with the new value.
3. `pnpm --filter @rakazo/api content-encryption rotate` re-wraps every space
   key under `k2`. Each new wrap is verified before it replaces the old one.
4. `status` should list space keys only under `k2`. Remove `k1` once backups
   that depend on it have expired.

Rotate data keys too (for example after suspected key exposure):
`content-encryption rotate --reencrypt` adds a new key version to every space
and every vault key (members' and Spaces' own), and re-encrypts messages,
events, memory, summaries, artifacts and vault items under it. Only vault items
already under a vault key move, the way `migrate` moves them: a save made
meanwhile wins, the item keeps its date, and an item that does not open stays as
it was and is reported with the reason. Items still in the `ENCRYPTION_KEY`
format are left as they are and counted as `not under a vault key (run
migrate)`; neither command creates a vault's first key. A vault key whose
member or Space is deleted during the run is skipped and counted as `owner
gone`. A vault key that cannot get a new version is reported with the reason;
the other keys still rotate, items still move, and the command exits with an
error at the end. Older versions keep decrypting until nothing uses them.
`migrate` and `reencrypt` read each vault's newest key version from the
database, not from memory, so they move items to a version that another
process has just added.

Rotation is not finished when `rotate --reencrypt` exits. Each API and worker
process keeps the key versions it has read in memory for up to ten minutes
(the default `ttlMs` of `ContentKeyRing` in `packages/db/src/content-keys.ts`).
For that long after a rotation, it may still seal new content and new vault
saves with the previous version. Those stay under that version until the next
`reencrypt`. An interrupted run also leaves items under the previous version.
After a suspected key exposure:

1. Run `content-encryption rotate --reencrypt`.
2. Wait ten minutes, or restart every API and worker process.
3. Run `content-encryption reencrypt`. It rotates no keys.
4. Run `content-encryption status`. Its `vault items under an older vault key
   version` line should read 0; if it does not, repeat steps 2 and 3. It counts
   vault items only, not Space content.

## External key management

`MASTER_KEY_PROVIDER=aws-kms` wraps space keys with an AWS KMS key instead of
master keys held by the API and worker. The key never leaves KMS, and a process
needs KMS each time it loads a space key (cached for up to ten minutes), so a
copy of the database and environment stops being decryptable once that access
is revoked. Set on the API and worker:

```dotenv
MASTER_KEY_PROVIDER=aws-kms
AWS_KMS_KEY_ARN=arn:aws:kms:<region>:<account>:key/<key id>
AWS_KMS_ACCESS_KEY_ID=replace-with-access-key-id
AWS_KMS_SECRET_ACCESS_KEY=replace-with-secret-access-key
```

Use a symmetric key and its key ARN, not an alias. Allow the credentials only
`kms:Encrypt` and `kms:Decrypt` on that key, and add an `aws:SourceIp` condition
so leaked credentials do not work from elsewhere. Each wrap carries the space id
and key version as encryption context, so CloudTrail records which space every
unwrap was for.

To move existing keys, deploy with these settings (keys wrapped by local master
keys keep unwrapping), run `content-encryption rotate`, and check that `status`
lists every space key under `aws-kms:<key id>`. Keep `ENCRYPTION_KEY`: stored
credentials still use it, apart from vault items under a vault key
([Infisical](./infisical-secrets.md) moves those out), and backups from before
the rotation still unwrap with it.

To replace the KMS key, point `AWS_KMS_KEY_ARN` at the new one, keep
`kms:Decrypt` on the old key, and run `rotate` again.

While KMS is unreachable, a process cannot read or write content in a space
whose key it has not cached. Vault items under a vault key depend on it the
same way: logins and cards cannot be filled, saving into a vault with a key
fails, and runs whose saved logins, cards and command variables cannot be loaded
do not start: an agent run retries its setup for about 18 minutes,
then fails with that reason, and a command change check is retried, without
waking the computer, until KMS is back. A run that had
already started runs its later shell commands without a variable it cannot
load. Startup logs master keys it cannot unwrap.

To run CLIs such as `content-encryption export` from a laptop with short-lived
credentials, set `AWS_KMS_PROFILE` to a named AWS profile (including one from
`aws login` or SSO) instead of the access key pair. Exactly one of the two must
be set, so leave the pair out of the laptop's `.env`, and the key policy must
allow that principal:

```bash
aws login --profile rakazo-kms
AWS_KMS_PROFILE=rakazo-kms pnpm -s --filter @rakazo/api content-encryption export --bot <bot id> > rakazo-export.jsonl
```

### Wrapped settings

With a key manager configured, any setting the API and worker read can be
stored in `.env` wrapped, so a copy of `.env` holds no usable application
secret; the KMS credentials it still holds only work from the server's address
(the `aws:SourceIp` condition above). Each
process unwraps them once at startup. To wrap a value the API already has:

```bash
docker compose -f docker-compose.images.yml exec -T api \
  sh -c 'printenv BETTER_AUTH_SECRET | node dist/cli/wrap-env.js BETTER_AUTH_SECRET'
```

For a new value, pipe it in instead of `printenv` (it is read from stdin, never
arguments). Replace the line in `.env` with the printed `wrapped:v1:…` value and
run `docker compose up -d`. The plaintext is unchanged, so nothing derived from
it changes. A wrapped value only unwraps under its own variable name.

`MASTER_KEY_PROVIDER` and the `AWS_KMS_*` settings cannot be wrapped, and
neither can values Compose interpolates into other settings or other containers
read, such as `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD` and `SCREEN_PROXY_SECRET`
(the web container reads it too). A wrapped value
without a key manager stops startup with the variable's name.

Other key managers implement the `KeyProvider` interface in
`@rakazo/adapter-kit` (`activeKeyId`, `wrap`, `unwrap`), pass the shared suite in
`packages/adapters/src/key-provider-conformance.test.ts`, and are selected in
`keyManagerFromEnv`. A provider only wraps 32-byte data keys: one per space
key and one per wrapped setting, never per stored message or file.
