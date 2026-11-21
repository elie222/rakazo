# Storage and encryption

Decide where files and bot homes live, how content is encrypted at rest, and how large uploads
may be.

## Data directory

`DATA_DIR` (`/data` in the Compose files, `./data` in a source checkout) holds uploaded and
generated files, bot homes and caches. By default the API and worker must share it and it must
persist. Bot homes and new artifacts can live in [object storage](#bot-homes-in-object-storage)
instead.

**With object storage from the first start**, nothing under `DATA_DIR` needs to be shared or to
survive a restart, so each API and worker replica can use its own scratch directory (a Pod's
`emptyDir`, for example), except for Docker computers, described below the table:

| Path                                           | What it holds with object storage                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `homes/`, `home-revisions/`, `home-downloads/` | A cache of bot homes, downloaded again when missing or older than the bucket.                                                               |
| `staging/`                                     | Scratch for saves, removed at startup. It needs free space for the largest home you want saved.                                             |
| `mcp-packages/`                                | Packages each process installs on first use; set `MCP_PACKAGES_DIR` to put them elsewhere.                                                  |
| `artifacts/`, `push-tokens/`                   | Nothing new. Only an install that started without object storage has files here; see [shared storage migration](#shared-storage-migration). |
| `pi-sessions/`                                 | Only with `PI_SESSION_RECORDING=true`. Each process keeps its own files, so leave it off or share the directory.                            |

Docker computers mount their cached home straight from the Docker host's `DATA_DIR/homes`, so the
API and worker that start them need that directory on the same host. Remote computer providers,
including Kubernetes with `OBJECT_STORAGE_BUCKET` set, copy the workspace through the server and
need no shared directory.

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

| Install                                                                     | Unset means                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------ |
| Compose files, published images, Railway                                    | `on`                                             |
| Desktop app, **This computer**                                              | `off` (the computer's disk encryption covers it) |
| Source checkout with `NODE_ENV=development` or `RAKAZO_ALLOW_DEV_SECRETS=1` | `off`                                            |

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
S3-compatible bucket or an Azure Blob Storage container instead, so `DATA_DIR` is only a cache and
API and worker hosts no longer need a shared disk for homes. Leave it unset to keep homes on local disk, as before.
The same connection also stores new artifacts; see [shared storage migration](#shared-storage-migration)
for migrating existing files and push registrations.

```env
OBJECT_STORAGE_BUCKET=rakazo-homes
OBJECT_STORAGE_ENDPOINT=https://storage.example.com
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_ACCESS_KEY_ID=replace-me
OBJECT_STORAGE_SECRET_ACCESS_KEY=replace-me
# Optional: s3 (the default) or azure-blob, below.
OBJECT_STORAGE_PROTOCOL=s3
# Optional: a key prefix, when the bucket holds anything else.
OBJECT_STORAGE_PREFIX=
# Optional: true for services that address buckets in the path rather than the host name.
OBJECT_STORAGE_PATH_STYLE=false
```

**Azure Blob Storage.** Azure Blob is not S3-compatible, so it has its own backend. Set
`OBJECT_STORAGE_PROTOCOL=azure-blob` and reuse the same settings: the bucket is the container name,
the access key ID is the storage account name and the secret access key is one of the account's
access keys. `OBJECT_STORAGE_ENDPOINT` is optional and is the account URL, for example
`http://127.0.0.1:10000/devstoreaccount1` for a local emulator or the account's URL in a sovereign
cloud; it defaults to `https://<account>.blob.core.windows.net`. `OBJECT_STORAGE_REGION` and
`OBJECT_STORAGE_PATH_STYLE` do not apply. The container must already exist. For the versioning and lifecycle
advice below, use the account's blob versioning and lifecycle management.

```env
OBJECT_STORAGE_PROTOCOL=azure-blob
OBJECT_STORAGE_BUCKET=rakazo-homes
OBJECT_STORAGE_ACCESS_KEY_ID=mystorageaccount
OBJECT_STORAGE_SECRET_ACCESS_KEY=replace-me
```

**Entra ID instead of the account key.** `OBJECT_STORAGE_AUTH` selects how the backend
authenticates, so no account key needs to live in the configuration. The access key ID keeps its
meaning — the storage account name — for every kind, and each kind adds its own settings:

| `OBJECT_STORAGE_AUTH` | Settings                                                                                                                | Use                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| unset (default)       | `OBJECT_STORAGE_SECRET_ACCESS_KEY` (the account key)                                                                    | the account key, as above                                                |
| `client-secret`       | `OBJECT_STORAGE_TENANT`, `OBJECT_STORAGE_CLIENT_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY` (the client secret)             | a service principal with a secret                                        |
| `client-certificate`  | `OBJECT_STORAGE_TENANT`, `OBJECT_STORAGE_CLIENT_ID`, `OBJECT_STORAGE_CERTIFICATE` (a PEM bundle path or the PEM itself) | a service principal with a certificate                                   |
| `federated-identity`  | `OBJECT_STORAGE_TENANT`, `OBJECT_STORAGE_CLIENT_ID`, `OBJECT_STORAGE_FEDERATED_TOKEN_FILE`                              | workload identity federation, such as a Kubernetes service account token |
| `managed-identity`    | `OBJECT_STORAGE_CLIENT_ID` optional (user-assigned)                                                                     | a managed identity on the host                                           |

```env
OBJECT_STORAGE_PROTOCOL=azure-blob
OBJECT_STORAGE_BUCKET=rakazo-homes
OBJECT_STORAGE_ACCESS_KEY_ID=mystorageaccount
OBJECT_STORAGE_AUTH=client-secret
OBJECT_STORAGE_TENANT=00000000-0000-0000-0000-000000000000
OBJECT_STORAGE_CLIENT_ID=11111111-1111-1111-1111-111111111111
OBJECT_STORAGE_SECRET_ACCESS_KEY=replace-me
```

Whatever the identity is, give it the **Storage Blob Data Contributor** role on the storage
account (or a narrower custom role with the same data actions). Entra ID tokens travel over TLS
only, so these kinds need an `https` endpoint or the default account URL; a plain-`http`
emulator endpoint keeps working with the account key. A certificate or federated-token file is
read when the server starts, so under Compose it must be mounted into the containers and named
by its in-container path.

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
so memory use does not grow with file or home size. A computer with more than 5 GiB (the
default; see below) or a million files, or more than the volume has free, is not saved and keeps
running unsaved. A system note in each bot’s thread asks you to remove large or unneeded files.
The worker also logs `computer.sleep_deferred` with reason `too_large` or `too_many_files`. Saves
leave out rebuildable caches, dependencies (`node_modules` and `.venv`), build output (`.next`
and `.turbo`), logs and core dump files. These files stay on the running computer but are absent
on a fresh restore.
Docker, Kubernetes and Railway put tool caches under `/tmp/rakazo-cache`, outside the saved home.
Staging left by a killed process is removed at startup and by the worker within minutes.

`WORKSPACE_SAVE_MAX_GB` sets the size limit in GiB. It defaults to `5` and accepts a positive
number up to `100`, such as `20` or `0.5`; `0`, negative, non-numeric and larger values stop the
API and worker at start. 100 GiB is the most a saved home can be restored from. The file limit
stays one million. Set it in `.env` for both the API and the worker, then restart them. The
volume's free space still applies, so keep the data volume larger than the limit.

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
object storage connection alongside computer homes. Artifact contents are always encrypted
before upload using the space's content key and authenticated segments bound to the
artifact identity. This applies even with `CONTENT_ENCRYPTION=off`. Metadata and access
checks remain in Postgres; clients and sandboxes receive neither bucket credentials nor
public object URLs. Without object storage, artifacts continue using the local volume.
Pictures shown on pages are stored, encrypted and migrated the same way as other artifacts.

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

Files sent in direct messages from chat apps download in the background, up to
`MAX_UPLOAD_SIZE_MB`, with retries. The sender is told when a file can't be received.

The bot gets a copy of each one in its computer; see
[attachment copies in computers](#attachment-copies-in-computers).

`MAX_ATTACHMENTS_PER_MESSAGE` sets the chat attachment count per message. It defaults
to `4` and accepts integers from `1` to `100`. Set it in `.env` and restart the API.
Web, desktop, and mobile use the advertised count; older clients and clients connected
to older servers keep the default of four. Chat bridges retain their existing safe
platform limits, and model image budgets still apply.

## Attachment copies in computers

When a bot's run uses a file, Rakazo copies it into the bot's computer, under `attachments/` in
the bot's folder (`bots/<bot>/attachments/` on a team computer). The original stays in Rakazo's
storage. Three groups of settings change how a copy is named, when it is made and how long it
stays. With none set, nothing changes: copies are named `attachments/<id>.<ext>`, are made when
a run needs them, and are never cleaned up. The bot is told each copy's path in the attachment
list of its message, so there is one copy and one path for each file.

### Names and folders

`ATTACHMENT_COPY_NAMES` is `id` (default) or `readable`. A readable copy of a new file gets a
path like this, and Rakazo stores it with the file so it never changes:

```text
attachments/<YYYY>/<MM>/<YYYY-MM-DD>_<HHMM>[_<sender>]_<name>.<ext>
```

`ATTACHMENT_COPY_FOLDERS` is `none` (default) or `month`, and applies only to readable names. With
`none` the files are in one folder, `attachments/<YYYY-MM-DD>_<HHMM>[_<sender>]_<name>.<ext>`.
Set it in `.env`; the API and worker both receive it.

- The date and time are when Rakazo received the file, not an email's own date. They are in the
  time zone of the account the file belongs to, or UTC when it has none set.
- The sender is the chat contact's label, an email's sender name (or its address when there is no
  name), or the name of the user who uploaded the file. When it is unknown, the part is left out.
- The sender and name lose characters a path can't hold, get `_` for each one Windows does not
  allow in a name, and are shortened to fit. A name already taken in the same space gets `-2`,
  `-3` and so on before the extension, so a copy never replaces a file.
- Only files that arrive after a change follow it. Files that already have a path keep it, and
  files without one (earlier ones, imports, files a bot attaches from its own computer) keep
  `attachments/<id>.<ext>`.
- A chat contact's label can be a phone number or an address, and a copy's name can carry it.
  Everyone with access to the computer can see it.

### Copy on arrival

`ATTACHMENT_COPY_ON_ARRIVAL=true` copies each file into the bot's computer when the message
arrives, so a large file is there by the time the bot's run starts. It is off by default: the
copy is then made when a run needs it. The API reads this setting. It covers direct chat-app
messages, email to a bot, and messages sent to one bot from the web or the apps. Files in group
and team chats are still copied when a run needs them. A web upload is copied when its message
is sent, not when the file is uploaded.

The copy never delays or fails the message. A run that finds the file already there does not
copy it again. Which computers get a copy:

- A running computer of any kind, Docker included, written straight into it, even while the bot
  works in it.
- An asleep Docker computer, written into the server's copy of its home. Its container is
  stopped while it sleeps, so nothing in it runs until it wakes.
- A stopped computer with no machine left whose home the server holds, written into that stored
  home for its next start. This covers Docker computers whose container was removed, and remote
  computers whose stored home only the server writes, except Kubernetes computers set up to
  mount the server's home directory.

Other computers get no copy on arrival: one starting or going to sleep, an asleep or stopped one
whose provider keeps its machine and disk, a stopped remote one whose stored home it writes
itself, a stopped one on a person's own device, and a bot with no computer. A run copies the
file when it needs it, as before.

### Cleanup

Cleanup deletes old attachment copies from computers. It is off by default.

| Setting                        | Default | Meaning                                                                       |
| ------------------------------ | ------- | ----------------------------------------------------------------------------- |
| `FILES_CLEANUP_ATTACHMENTS`    | `false` | `true` turns the cleanup on.                                                  |
| `FILES_CLEANUP_MAX_AGE_DAYS`   | `31`    | How old a copy gets before it is deleted. A whole number from `1` to `36500`. |
| `FILES_CLEANUP_INTERVAL_HOURS` | `24`    | How often the cleanup runs. A whole number from `1` to `8760`.                |

The worker does the cleanup and checks these settings: a value that is not understood stops the
worker from starting, with an error naming the setting. The two number settings are shared with
other file cleanups. The other settings are checked at startup too, by the API:
`ATTACHMENT_COPY_NAMES` and `ATTACHMENT_COPY_FOLDERS` stop it with an error naming the setting
when they hold any other value. `ATTACHMENT_COPY_ON_ARRIVAL` is not checked: only `true` turns it
on, and any other value leaves it off.

An age comes from the file's own record, because a home's file list has no file times:

- a readable copy, by the date at the start of its name, inside matching `YYYY/MM` folders or
  directly in `attachments/` when folders are off;
- an old copy named `attachments/<id>.<ext>`, by when that file was created in Rakazo.

The cleanup then removes the year and month folders that this leaves empty. It cleans
`attachments/` on a private computer, and each bot's `bots/<bot>/attachments/` on a team
computer. It leaves alone anything in `attachments/` that
is not named like a copy. The original stays in Rakazo's storage, and a later run copies it back
if it needs it; the new copy gets a fresh age.

It only cleans homes the server holds while nothing runs in them: the same computers that get a
copy on arrival while not running. It never cleans a running computer. Copies on a running
computer go once it is asleep or stopped and its home is back with the server, and a computer
that never stops is not cleaned. Neither are computers that keep their own disk, such as one
whose provider keeps its machine. Turning the setting off stops the cleanup, so copies already
made stay until removed by hand.

### Limits

- A message settled by its backup job, because receiving it here failed or the API restarted
  first, reaches the bot without an arrival copy, and so does a message the chat app delivers
  again after such a restart. The run copies the file when it needs it.
- One copy at a time is made on a computer, across all API processes, and the cleanup takes the
  same turn. Each arrival copy has 30 seconds, waiting included; one not made by then is skipped,
  and the next copy goes ahead. A copy still being written at that point can land later; the
  cleanup removes it like any other.
- A run that starts while a file is being copied on arrival can write the same file again. The
  result is the same file.
- A message's files are copied between its downloads, so each later file of the message starts
  downloading a little later, within the same download time limit.
- A copy into an asleep or stopped computer's stored home, and the cleanup of one, are not held
  against a start or a save of that computer. If the computer starts from its previous save and
  then saves again, the copy can be lost although the bot was told its path; the same can happen
  on a running computer that saves and stops between the check of its state and the write. An
  asleep Docker computer that wakes between that check and the write has its container running
  again while the server writes in its home. The cleanup looks at the computer again before
  every 25 deletions and stops at any change, deletes at most 500 copies in one home per pass,
  and leaves the rest for the next pass.
- A stopped Docker computer is treated as having no container only once Rakazo removed its
  container or found it gone. If a container is still there although Rakazo took it for gone,
  the server can write in or clean a home that container still mounts.
- With homes kept in object storage, an asleep Docker computer whose last save was skipped
  because its home was too large still gets the copy in its home, but storing the home fails, so
  the copy is lost.
- With homes kept in object storage, each copy into a computer that is not running downloads its
  stored home and uploads it again whole. A large home can take longer than the 30 seconds,
  leaving the file to be copied by the run. The cleanup downloads every home it looks at, and
  uploads it again after every 25 deletions.
- A message handed to a message routine still gets its copies, but the routine is not told where
  they are.
