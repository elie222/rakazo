# Storage and encryption

Decide where files and bot homes live, how content is encrypted at rest, and how large uploads
may be.

## Data directory

`DATA_DIR` (`/data` in the Compose files, `./data` in a source checkout) holds uploaded and
generated files, bot homes and caches. The API and worker must share it and it must persist. Bot
homes and new artifacts can live in [object storage](#bot-homes-in-object-storage) instead.

## Content encryption

Rakazo encrypts chat messages, thread events, compacted history summaries, memory documents and
their revisions, and uploaded or generated files before they reach PostgreSQL or `DATA_DIR`.
Names, ids, timestamps and other metadata stay readable. Credentials are always encrypted,
whatever this setting says. Details and the threat model are in
[content encryption](./content-encryption.md).

**The key.** Content is encrypted under keys derived from `ENCRYPTION_KEY` (and
`ENCRYPTION_MASTER_KEYS`, if set). Without them, a backup of the database and `DATA_DIR` cannot
be read, by you or by anyone else. `install-images.sh` says so once, when it generates the key:

```text
Back up ENCRYPTION_KEY from /path/to/rakazo/.env. Encrypted content cannot be recovered without it.
```

It never prints the key. Store a copy somewhere other than the server and its backups.

**The switch.** `CONTENT_ENCRYPTION=on|off` in `.env`:

| Install | Unset means |
| --- | --- |
| Compose files, published images, Railway | `on` |
| Desktop app, **This computer** | `off` (the computer's disk encryption covers it) |
| Source checkout with `NODE_ENV=development` or `RAKAZO_ALLOW_DEV_SECRETS=1` | `off` |

With `off`, new content and files are stored readable, so you can query your own database
directly and a lost key cannot lose them. Content encrypted earlier still reads with the key, so
switching off never makes data unreadable. To convert it too, run `content-encryption decrypt`.
Any other value stops the API and worker at startup.

To switch on later, set `CONTENT_ENCRYPTION=on`, restart, then encrypt what was stored while
it was off. From the published-images folder (other stacks use their own Compose file):

```bash
docker compose -f docker-compose.images.yml exec api pnpm --filter @rakazo/api content-encryption migrate
docker compose -f docker-compose.images.yml exec api pnpm --filter @rakazo/api content-encryption status
```

Search works in both modes and while rows are mixed.

**Reading your data.** `content-encryption export` writes decrypted threads, messages, memory
documents and revisions as JSON lines. It reads the whole database by default; narrow it with
`--space <id>`, `--thread <id>` or `--bot <id>`. It only reads.

```bash
docker compose -f docker-compose.images.yml exec -T api \
  pnpm -s --filter @rakazo/api content-encryption export --bot <bot id> > rakazo-export.jsonl
```

The export is plaintext: store it like the database itself. Files are not included; use
`content-encryption decrypt` to make them readable on disk.

New credentials use versioned AES-GCM with per-record salt and row-bound AAD. Legacy ciphertext stays readable.

## Bot homes in object storage

Each bot computer has a home: its files, logged-in browser profiles and CLI tokens. By default
homes live under `DATA_DIR/homes` on the server. Set `OBJECT_STORAGE_BUCKET` to keep them in any
S3-compatible bucket instead, so `DATA_DIR` is only a cache and API and worker hosts no longer need
a shared disk for homes. Leave it unset to keep homes on local disk, as before.
The same connection also stores new artifacts; see [shared storage migration](#shared-storage-migration)
for migrating existing files and push registrations.

```env
OBJECT_STORAGE_BUCKET=rakazo-homes
OBJECT_STORAGE_ENDPOINT=https://storage.example.com
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_ACCESS_KEY_ID=replace-me
OBJECT_STORAGE_SECRET_ACCESS_KEY=replace-me
# Optional: a key prefix, when the bucket holds anything else.
OBJECT_STORAGE_PREFIX=
# Optional: true for services that address buckets in the path rather than the host name.
OBJECT_STORAGE_PATH_STYLE=false
```

Only the API and worker read these settings. Bot computers never receive the credentials or
links to stored objects; files still reach them through the server, as before. The settings
apply to every provider, including Docker computers, which keep mounting their cached home.

**Encryption.** Homes are encrypted on the server before upload, whatever `CONTENT_ENCRYPTION`
says; the bucket only ever holds ciphertext. Each home has its own random data key, kept on the
computer's database row and wrapped by its space's content key (see
[content encryption](./content-encryption.md)). Each stored revision is one object, sealed in
authenticated segments bound to that home and revision, so a modified, truncated or swapped
object fails to restore instead of restoring the wrong files. Object keys are random ids
(`homes/<id>/<revision>`) that name no bot, user or space. Back up the database and the
encryption keys as before: the bucket cannot be read without them.

**The bucket.** Use a private bucket, or a prefix of one, for this deployment alone: the worker
deletes objects under `homes/` that no home in this database owns. Block public access. The
credentials need to read, write, list and delete objects in it, and nothing else. Turn on bucket
versioning, with a lifecycle rule that expires noncurrent versions after your backup window, so
a mistaken deletion can be undone. `scripts/backup.sh` does not copy the bucket; versioning, or the
service's own replication, is its backup.

**What is stored.** Each save uploads the whole home as one object (in parts of up to 16 MiB for
large homes) and then deletes the previous one, so a home costs about one object however many
files it has. Homes are saved when a run finishes or fails, before a computer stops, and before
it sleeps, as before.

**Deleting.** Deleting a bot with its own computer, or a space (including the personal spaces
removed with an account), deletes each home's key with its computer's row, so the stored objects
become unreadable at once. The worker deletes those
objects within the hour, along with any revision an interrupted save left behind.

**The cache.** `DATA_DIR/homes` holds a copy of homes in use. A copy whose revision matches the
bucket is downloaded again whenever it is missing, so you can remove it. Docker computers work
directly in their copy until their next save, so only remove the copy of a Docker computer that
is stopped. Remote computers save straight from their files to the bucket; the worker removes
their copies after an hour unread. Homes never saved to the bucket keep their only copy.

**Saving large homes.** A save streams files through `DATA_DIR/staging` on the data volume,
so memory use does not grow with file or home size. A computer with more than 5 GiB or a
million files, or more than the volume has free, is not saved and keeps running unsaved. A system
note in each bot’s thread asks you to remove large or unneeded files. The worker also logs
`computer.sleep_deferred` with reason `too_large` or `too_many_files`. Saves leave out rebuildable
caches, dependencies (`node_modules` and `.venv`), build output (`.next` and `.turbo`), logs and
core dump files. These files stay on the running computer but are absent on a fresh restore.
Docker, Kubernetes and Railway put tool caches under `/tmp/rakazo-cache`, outside the saved home.
Staging left by a killed process is removed at startup and by the worker within minutes.

### Moving existing homes

After setting the bucket, restart the API and worker. Each home is uploaded the next time it is
saved; until then its local copy is used. To upload the rest at once, run this where `DATA_DIR`
is mounted. It skips homes already stored, so it can be stopped and run again. Each upload is
downloaded and checked before the home counts as moved. It never deletes local files.

```bash
docker compose -f docker-compose.images.yml exec api pnpm --filter @rakazo/api home-storage migrate --dry-run
docker compose -f docker-compose.images.yml exec api pnpm --filter @rakazo/api home-storage migrate
```

Homes listed as having no computer belong to bots that no longer exist; they are left alone.
Once a run reports no failures and nothing left to upload, remove the local copies: stop Docker
computers, stop the API and worker, move `DATA_DIR/homes` and `DATA_DIR/home-revisions` aside,
start them again and check a few bots' files, then delete the moved directories.

## Shared storage migration

Push notification registrations now live in Postgres, encrypted with `ENCRYPTION_KEY`.
The same key must be configured on every API and worker replica. Registrations remain
bound to their authenticated session; deleting an account also deletes its registration.

With `OBJECT_STORAGE_BUCKET` configured, new artifact contents use the existing
S3-compatible connection alongside computer homes. Artifact contents are always encrypted
before upload using the space's content key and authenticated segments bound to the
artifact identity. This applies even with `CONTENT_ENCRYPTION=off`. Metadata and access
checks remain in Postgres; clients and sandboxes receive neither bucket credentials nor
public object URLs. Without object storage, artifacts continue using the local volume.

Existing artifact rows continue reading their local files until migrated. Before spreading
API or worker replicas across machines, migrate files from every original application
volume. Back up the database and volume first. Deploy the schema migration and the new
application version, then stop **all API and worker processes**, including old releases,
while running the following commands from a maintenance container with the original volume,
`DATABASE_URL`, `ENCRYPTION_KEY`, content master keys, and object storage configuration:

```sh
# Published image (run from /app/apps/api):
node dist/cli/shared-storage.js artifacts --dry-run
node dist/cli/shared-storage.js artifacts
node dist/cli/shared-storage.js push-tokens --dry-run
node dist/cli/shared-storage.js push-tokens

# Source checkout equivalents:
pnpm --filter @rakazo/api shared-storage artifacts
pnpm --filter @rakazo/api shared-storage push-tokens
```

The artifact migration uploads and decrypts each file to verify it before conditionally
updating its database storage key. It keeps the original local files and skips rows already
migrated, so interrupted runs can resume. A database failure after upload can leave an
unreferenced object; do not delete objects blindly after a failed migration. Keep local
originals until the migration is complete and verified. Files absent from the mounted volume
are counted as pending while migration continues for files present on that volume. Run the
command on each original volume, then run `artifacts --dry-run` again and require `pending: 0`
before starting independent replicas. Object-backed artifacts require
object storage to remain configured; old application versions cannot read their new keys.
The local content-encryption CLI operates on local artifacts only; object artifacts stay
encrypted and retain access through the key versions referenced in their headers.

The push import preserves registrations with a live session, skips missing/expired or
sessionless registrations, accounts already registered in Postgres, and devices owned by any
existing database registration. Import never hands a device back to an older account. It archives processed
files with a `.migrated` suffix. Those archives are never used as a runtime fallback, so they
cannot restore a registration after logout. Clients skipped during migration register again
when they next open the app. Remove the archived token files after verifying the import.
Restart API and worker processes after both commands finish. A schema-only rollback remains
compatible with the previous release, but the old code does not read database registrations
or object-backed artifacts.

## Upload size

`MAX_UPLOAD_SIZE_MB` sets the per-file chat attachment and computer file transfer limit
in MiB (1 MiB = 1,048,576 bytes). It defaults to `10` and must be a positive integer.
Set it in `.env` and restart the API, worker, and Docker supervisor (when used). Web, desktop, and mobile use the
limit advertised by the server. If a reverse proxy limits request bodies, allow
room for base64 encoding (about 4/3 of the file size) and the JSON envelope.

`MAX_ATTACHMENTS_PER_MESSAGE` sets the chat attachment count per message. It defaults
to `4` and accepts integers from `1` to `100`. Set it in `.env` and restart the API.
Web, desktop, and mobile use the advertised count; older clients and clients connected
to older servers keep the default of four. Chat bridges retain their existing safe
platform limits, and model image budgets still apply.
