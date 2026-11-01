# Content encryption at rest

Rakazo encrypts user content before it reaches PostgreSQL or the artifact
directory, so a copied database dump, backup or disk does not reveal it.

## What is encrypted

| Data | Where |
| --- | --- |
| Chat messages | `messages.blocks` |
| Thread events (they repeat message content) | `events.payload` |
| Compacted history summaries | `threads.historyCompactionSummary` |
| Memory documents and their revisions | `memory_documents.content`, `memory_revisions.content` |
| Uploaded and generated files | `DATA_DIR/artifacts/<space>/<file>` |
| Bot computer homes kept in [object storage](./self-host-storage.md#bot-homes-in-object-storage) (always, whatever `CONTENT_ENCRYPTION` says) | `homes/<id>/<revision>` in the bucket |
| Credentials (unchanged scheme) | `secrets`, `bot_secrets`, `integration_provider_configs` |

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
- Deleted spaces: deleting a space deletes its keys (a database trigger), so
  ciphertext left in unvacuumed pages, WAL or orphaned files is unreadable.

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
4. Encrypt existing content, then check nothing is left:

   ```bash
   pnpm --filter @rakazo/api content-encryption migrate --dry-run
   pnpm --filter @rakazo/api content-encryption migrate
   pnpm --filter @rakazo/api content-encryption status
   ```

   `migrate` works in batches, locks each batch while rewriting it, and can be
   interrupted and rerun. It also upgrades credentials still stored in the
   pre-v2 format (no record binding) to the current format. Run it where
   `DATA_DIR` is mounted so artifacts are encrypted too.

To roll back to a release without encryption, run
`content-encryption decrypt` first; older releases cannot read ciphertext.

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
and re-encrypts messages, events, memory, summaries and artifacts under it.
Running processes may keep writing with the previous version for up to ten
minutes, so run `content-encryption reencrypt` again after that.

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
credentials still use it ([Infisical](./infisical-secrets.md) moves those out),
and backups from before the rotation still unwrap with it.

To replace the KMS key, point `AWS_KMS_KEY_ARN` at the new one, keep
`kms:Decrypt` on the old key, and run `rotate` again.

While KMS is unreachable, a process cannot read or write content in a space
whose key it has not cached. Startup logs master keys it cannot unwrap.

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
