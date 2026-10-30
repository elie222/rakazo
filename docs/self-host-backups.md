# Backup and restore

Back up the database and application data, keep encrypted copies off the server, and recover to
a snapshot or a moment in time.

## Source checkout backups

```bash
./scripts/backup.sh
```

This dumps Postgres (`pg_dump`) and archives `data/` into `backups/<stamp>/`. Backup
directories have mode `0700`, and both artifacts have mode `0600`, including on reused paths.
A missing `data/` or `RAKAZO_BACKUP_SKIP_HOMES=1` produces an empty archive that restore treats
as omitted homes. Database or archive errors fail the backup. Discard the output directory of
any failed run.

## Restore

For backups created by `scripts/backup.sh`, use an empty `rakazo` database in the development
Compose stack. The script validates and extracts the homes archive in a clean sibling directory
before touching the database, then stops the API, worker, and supervisor. It rejects a `data/`
path that is a symlink or a non-directory. Stop bot computers and any other processes that
write to this database or tree before running the script.

The SQL import runs in one transaction and stops on the first error, including conflicts with
existing tables. An invalid archive or failed import leaves the current data tree unchanged.
After SQL succeeds, the script moves the current tree to `data.rollback.<random>/data`,
prints that path, and replaces `data/` with the saved tree. Files absent from the snapshot
do not remain in the active tree. A missing homes archive or an empty archive from omitted homes
leaves `data/` unchanged. An archive containing an empty `data/` directory replaces it with an
empty tree.

Application services start only after the import and tree replacement succeed. Once writer
shutdown starts, a later failure or interruption makes the script attempt to stop the API,
worker, and supervisor again. This includes services that started before final startup failed.
The script preserves the original failure status even if cleanup fails. If Docker cannot stop
the services, stop them before recovery.

A failure after the SQL commit cannot roll back the database automatically. Leave the
application stopped, preserve both trees, and recover a matching database before moving the
rollback tree back to `data/`. Keep a separate database backup from before recovery if you
need that rollback. This script does not consume the production snapshot's custom-format
`rakazo.dump` or `appdata.tgz`.

```bash
./scripts/restore.sh backups/<stamp>
```

## Production backups

For the single-VM production layout, install `infra/compose/backup-prod.sh` as
`/usr/local/sbin/rakazo-backup` and enable the supplied `rakazo-backup.timer`. It creates a verified
Postgres custom-format dump plus an application-data archive under `/var/backups/rakazo`, with mode
`0600`. It keeps up to `RAKAZO_BACKUP_KEEP` verified snapshots (default `3`), bounded by
`RAKAZO_BACKUP_MAX_GB` (default `50` GiB), and reserves `RAKAZO_BACKUP_MIN_FREE_GB` (default `5`
GiB) of free disk space. Before starting, it removes abandoned partial snapshots and excess history,
then checks capacity by scaling only the previous appdata archive by appdata source growth,
plus the previous database dump size. Snapshots without source-size
metadata use the raw source size for their initial estimate. It preserves the newest
verified snapshot when capacity is insufficient, caps output file sizes, and removes a failed run's
partial snapshot. Local snapshots alone do not survive losing the host; encrypt them and copy them
off-site as described below.

The scheduled backup uses `/srv/rakazo` by default. For another deployment directory, set
`RAKAZO_DEPLOY_DIR=/absolute/path/to/checkout` in a root-owned `/etc/rakazo/backup.env`
(mode `0600`). The service reads this optional file on each run; the script uses the selected
checkout's `.env` and production Compose file. If the stack was started with a custom `-p`,
set the same `COMPOSE_PROJECT_NAME` in that file. Set the retention and space settings there too.
When updating an existing installation, reinstall the script and units, then run
`systemctl daemon-reload`; pulling the repository does not update `/usr/local/sbin` copies.

For a dedicated backup disk, mount it persistently and bind its `backups` directory onto
`/var/backups` in `/etc/fstab`. Add `x-systemd.requires-mounts-for=/mnt/your-backup-volume` to the bind
mount options. Set `RAKAZO_BACKUP_REQUIRE_VOLUME=1` and add a service drop-in containing
`RequiresMountsFor=/var/backups` and `AssertPathIsMountPoint=/var/backups` under `[Unit]`. The script
then refuses to fall back to root storage if the mount is missing or points at the root filesystem.

## Encrypted and off-site backups

Backups are encrypted with [age](https://age-encryption.org) to public recipients only, so the host
can write backups it cannot read. Generate the key pair on a machine you control, not on the server,
and keep the identity file (the private key) offline, ideally with a second recipient held by
another operator:

```bash
age-keygen -o rakazo-backup.key   # prints "Public key: age1..."
```

`harden-host.sh` installs `age`; on other hosts run `apt-get install age`. Then set the public keys in
`/etc/rakazo/backup.env`, separated by spaces, or point at a recipients file with one key per line:

```env
RAKAZO_BACKUP_AGE_RECIPIENTS=age1exampleprimaryrecipient age1examplerecoveryrecipient
# or: RAKAZO_BACKUP_AGE_RECIPIENTS_FILE=/etc/rakazo/backup-recipients.txt
```

With recipients set, each snapshot holds `rakazo.dump.age`, `appdata.tgz.age`, `SOURCE_SIZE_KB`,
and `SHA256SUMS`. `pg_dump` and `tar` stream straight into age, so plaintext never touches disk.
Verification needs no private key: `pg_restore --list` and `tar -t` read the same plaintext stream
while it is encrypted, each file must carry an age header, and the checksums cover the encrypted
files.

Without recipients the backup stays plaintext as before, logs a warning, and the host check alerts
that the latest backup is not encrypted. After the first encrypted backup, a run without recipients
fails instead of quietly writing plaintext. Set `RAKAZO_BACKUP_ALLOW_PLAINTEXT=1` only to accept
plaintext on purpose; it also silences the host-check alert.

For an off-site copy, install `rclone` and set `RAKAZO_BACKUP_OFFSITE_REMOTE` to any
[rclone remote](https://rclone.org/overview/) and path, such as an S3-compatible bucket or an SFTP
server. Configure the remote with rclone's own settings in the same file, for example:

```env
RAKAZO_BACKUP_OFFSITE_REMOTE=offsite:rakazo-backups
RAKAZO_BACKUP_OFFSITE_KEEP=14
RCLONE_CONFIG_OFFSITE_TYPE=s3
RCLONE_CONFIG_OFFSITE_PROVIDER=Other
RCLONE_CONFIG_OFFSITE_ENDPOINT=https://s3.example.com
RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=replace-me
RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=replace-me
```

After each verified local snapshot, the encrypted files are uploaded to `<remote>/<stamp>/`,
checked with `rclone check`, and only then given `SHA256SUMS`, which marks the copy complete. Off-site copies require encryption. The remote
keeps the newest `RAKAZO_BACKUP_OFFSITE_KEEP` complete snapshots (default `14`), independent of
`RAKAZO_BACKUP_KEEP`; only stamp-named directories are removed. Set it to `0` to leave deletion to
the bucket's lifecycle rules, so the credentials need list, read and write but no delete permission. A failed upload keeps the
local snapshot but fails the service, so the backup alert fires.

## Restoring an encrypted backup

Run these where the identity file lives, never leaving it on the server. Fetch a snapshot with
`rclone copy offsite:rakazo-backups/<stamp> ./<stamp>` or `scp`, then run the drill, which checks the
checksums and decrypts each file into `pg_restore --list` and `tar -t` without writing plaintext
(it needs `age`, `pg_restore` of the server's major version or newer, which is 18 for the
production Compose file, and `tar`):

```bash
bash infra/compose/backup-drill.sh ./<stamp> rakazo-backup.key
```

**Never extract appdata over the active volume.** Files created after the snapshot would survive
and mix with the restored database. Extract into a clean sibling directory, then preserve the
old tree before replacing it. Pause automatic deploys and the updater during recovery. Stop
any other processes that write to this database or volume. Keep the application stopped if
any step fails.

Run these commands in one Bash session on the machine with the identity file. Replace the
snapshot and volume names first. `VOLUME` must name the volume the API currently mounts at
`/data`, which can differ when the stack uses another project name.

```bash
set -euo pipefail
umask 077
COMPOSE="sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml"
VOLUME=rakazo-prod_appdata

ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE stop api worker web"
ROLLBACK_DUMP="$(mktemp "$PWD/before-restore.dump.XXXXXX")"
if ! ssh deploy@app.example.com \
  "cd /srv/rakazo && $COMPOSE exec -T postgres sh -c 'pg_dump -Fc -U \"\$POSTGRES_USER\" \"\$POSTGRES_DB\"'" \
  > "$ROLLBACK_DUMP"; then
  printf 'Pre-restore dump failed. Do not use the partial file at %s. Keep the application stopped.\n' "$ROLLBACK_DUMP" >&2
  exit 1
fi

APPDATA="$(ssh deploy@app.example.com "sudo docker volume inspect -f '{{.Mountpoint}}' '$VOLUME'")"
RESTORE="$(ssh deploy@app.example.com "sudo mktemp -d '${APPDATA%/*}/rakazo-restore.XXXXXX'")"
ssh deploy@app.example.com "sudo mkdir '$RESTORE/staged'"
printf 'Record this rollback pair:\nDatabase dump: %s\nData tree on deploy@app.example.com: %s/previous\n' \
  "$ROLLBACK_DUMP" "$RESTORE"
age -d -i rakazo-backup.key <stamp>/appdata.tgz.age | ssh deploy@app.example.com \
  "sudo tar -xzf - --numeric-owner -C '$RESTORE/staged'"

age -d -i rakazo-backup.key <stamp>/rakazo.dump.age | ssh deploy@app.example.com \
  "cd /srv/rakazo && $COMPOSE exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"'"

ssh deploy@app.example.com \
  "sudo mv -- '$APPDATA' '$RESTORE/previous' && sudo mv -- '$RESTORE/staged' '$APPDATA'"
ssh deploy@app.example.com \
  "cd /srv/rakazo && $COMPOSE up -d --force-recreate --wait --pull never api worker web"
```

The archive must extract successfully before the SQL import starts. The clean staging directory
and the rollback tree sit beside the volume's active data directory, on the same filesystem.
Recreating the application containers makes them mount the replacement directory.
`--single-transaction` rolls back SQL errors, but it cannot include the directory switch.
After the import commits, a failed switch or startup can leave the database and active tree
out of sync. If startup fails, stop `api worker web` again, including containers that did start.

`$ROLLBACK_DUMP` names a private, plaintext rollback dump. `mktemp` creates a new mode-`0600`
file for each attempt without overwriting `before-restore.dump`, earlier rollback dumps, or
existing symlink targets. If the dump fails, the commands stop with the application still
stopped. The printed partial file is not usable rollback data. Preserve earlier rollback pairs
and fix the dump failure before starting another recovery attempt.

Record the printed database dump path together with its matching remote `$RESTORE/previous`
tree path. Keep that pair until you have checked the restored application. Do not remove the
Docker volume while you need the rollback tree. For rollback after SQL commits, keep the
application stopped and restore the recorded `$ROLLBACK_DUMP` into a freshly created empty
database. Move the failed active tree to a separate path for diagnosis, then move that attempt's
recorded `$RESTORE/previous` tree back to `$APPDATA` and recreate the application containers.
If the first directory move failed, the old tree is still at `$APPDATA`. Inspect both paths
before moving anything. Switching the tree alone does not roll back the database.

Plaintext snapshots use `cat` in place of `age -d` and the filenames `rakazo.dump` and
`appdata.tgz`. Use the same clean-directory procedure.

To restore into a new stack, create the `rakazo_app` role before the procedure above. The dump
grants to it, and on a new stack only the migration step would create it, so `pg_restore`
stops without it. Do not run the migrations first: tables newer than the snapshot would block
the restore. The procedure's final start applies them.

```bash
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE up -d --wait postgres"
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE exec -T postgres sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"CREATE ROLE rakazo_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE\"'"
```

## Point-in-time recovery

The nightly backup can lose up to a day. Point-in-time recovery streams the database's write-ahead
log (WAL) to S3-compatible object storage and takes a base backup every 24 hours, so the database
can be restored to any moment in the last `PITR_RETAIN_DAYS` (default `7`) and a lost server costs
about a minute of writes. It covers the database only; keep the nightly backup for application
data. It is off by default and needs the production Compose file with Postgres 18.

The optional `pitr` service streams WAL with `pg_receivewal` over the internal `data` network,
using a replication-only login and a replication slot, and uploads from its own network, so
Postgres keeps no internet access. Postgres closes a WAL segment at least every minute while
anything is written (`archive_timeout`). Each segment and base backup is encrypted with
[age](https://age-encryption.org) to public recipients before it leaves the container, as the
nightly backup is, so the server cannot read its own backups. You can use the same recipients.

The slot keeps WAL that has not reached the sidecar, so a sidecar restart leaves no gap. Disk use
stays bounded if uploads stall: the sidecar holds at most `PITR_MAX_WAL_GB` (default `4`) of
compressed WAL waiting to upload, then pauses streaming, and Postgres keeps at most that much again
for the slot (`max_slot_wal_keep_size`). Beyond that Postgres drops the slot's WAL, recovery has a
gap, and the sidecar takes a new base backup once it reconnects.

Use a bucket of its own. Its credentials need to list, read, write and delete objects in it;
deletes only remove backups older than the retention window. With `PITR_RETAIN_DAYS=0` nothing is
deleted, so no delete permission is needed and the bucket's lifecycle rules handle expiry. Add to
`.env`:

```env
COMPOSE_PROFILES=pitr
PITR_DATABASE_PASSWORD=replace-with-openssl-rand-hex-24
PITR_BUCKET=example-rakazo-pitr
PITR_ENDPOINT=https://s3.example.com
PITR_REGION=example-region
PITR_ACCESS_KEY_ID=replace-me
PITR_SECRET_ACCESS_KEY=replace-me
PITR_AGE_RECIPIENTS=age1exampleprimaryrecipient age1examplerecoveryrecipient
# Optional: PITR_PREFIX (a key prefix), PITR_PATH_STYLE=true (path-style bucket addressing),
# PITR_RETAIN_DAYS, PITR_MAX_WAL_GB.
```

`COMPOSE_PROFILES` is comma-separated; with the updater it is `updater,pitr`. Leave `PITR_ENDPOINT`
unset for AWS S3. Then turn it on from the checkout:

```bash
sudo infra/compose/pitr.sh enable
```

This creates the `rakazo_pitr` replication login, allows it in `pg_hba.conf`, sets
`archive_timeout` and `max_slot_wal_keep_size`, and reloads Postgres without restarting it. The
sidecar then takes its first base backup. Run `enable` again after changing `PITR_DATABASE_PASSWORD`
or `PITR_MAX_WAL_GB`, or after moving Postgres to a new cluster. Uploads are grouped by the
cluster's system identifier, so a new cluster never overwrites an old one's WAL.

The sidecar's health check fails when an upload has waited over ten minutes, streaming is paused,
nothing is streaming from the slot, or the last base backup is over 30 hours old. With
`RAKAZO_MONITOR_COMPOSE_PROJECT` set, the host check alerts on it. For details:

```bash
sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec pitr rakazo-pitr health
```

Restores run on any machine with Docker and this checkout. The identity comes on stdin and stays in
memory inside the restore container. Prove the latest point restores, into a scratch volume that is
removed afterwards. Run it after enabling, after changing the PITR scripts, and periodically:

```bash
sudo infra/compose/pitr.sh drill < rakazo-backup.key
```

Away from the server, set `PITR_ENV_FILE` to a file holding only the `PITR_` storage settings. To
recover production to a moment, stop everything that writes to the database and restore into its
volume. The current cluster is moved aside inside the volume, not deleted. The time is read as UTC
unless it names a zone:

```bash
COMPOSE="sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml"
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE stop api worker web pitr postgres"
ssh deploy@app.example.com \
  "cd /srv/rakazo && sudo infra/compose/pitr.sh restore '2026-01-31 09:41:00+00' rakazo-prod_postgres" \
  < rakazo-backup.key
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE up -d --wait"
```

The restore uses the newest base backup that finished before the target, replays WAL up to it, and
promotes the result, which starts a new timeline; the sidecar takes a fresh base backup for it. Pause
CI deploys during recovery. Once the restored database checks out, remove the old cluster:
`$COMPOSE run --rm --no-deps --entrypoint sh postgres -c 'rm -rf "$PGDATA".before-restore-*'`.

To turn it off, remove `pitr` from `COMPOSE_PROFILES`, then run `sudo infra/compose/pitr.sh disable`.
It removes the sidecar, the slot (so Postgres stops keeping WAL for it), the login and the
settings. Uploaded backups stay in the bucket.

## Moving an account between installs

To move from Rakazo Cloud to your own install (or back), use **Settings → Export data** on the
old install and **Import data** on the new one. The export is a zip of every space you belong
to: bots, chats, files, memory, routines, skills, bot workspace files and, in spaces you own,
the board. Content is decrypted inside the zip, so keep it private. Importing creates new
spaces you own. Routines arrive switched off. Credentials and connections (model keys, apps,
MCP servers, messaging) stay behind, so connect them again on the new install. Workspace files
over 8 MiB are left out, the export must stay under 4 GiB, and the upload must finish within
the server's request timeout (5 minutes by default in Node).
