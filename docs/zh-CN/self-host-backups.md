# 备份与恢复

[English](../self-host-backups.md) | 简体中文

数据库和应用文件必须一起备份。将加密副本保存在服务器之外，并定期演练恢复。
下文区分源码开发环境和生产环境；两者的备份格式与恢复命令不能混用。

## 源码开发环境

在仓库根目录运行：

```bash
./scripts/backup.sh
```

脚本使用 `pg_dump` 备份数据库，并将 `data/` 打包到 `backups/<stamp>/`。
备份目录权限是 `0700`，文件权限是 `0600`，即使复用已有路径也会设置权限。
没有 `data/`，或设置 `RAKAZO_BACKUP_SKIP_HOMES=1` 时，会生成空归档，恢复时视为未包含主目录。
数据库或归档失败会使备份失败，应丢弃该次输出目录。

### 恢复源码备份

`scripts/restore.sh` 只接收上面脚本生成的备份，目标是开发 Compose 中的空 `rakazo` 数据库：

```bash
./scripts/restore.sh backups/<stamp>
```

运行前停止机器人计算机和其他写入该数据库或数据目录的进程。
脚本会先在干净的同级目录验证并解包主目录归档，再停止 API、worker 和监督服务。
它拒绝符号链接或非目录的 `data/` 路径。

SQL 在单个事务中导入，遇到错误（包括已有表冲突）立即停止。无效归档或导入失败不会替换当前文件目录。
SQL 成功后，原目录移到 `data.rollback.<random>/data`，脚本打印回滚路径，再替换为备份中的目录。
快照里没有的文件不会留在新的活动目录中；缺失或空归档不改动现有目录，但包含空 `data/` 的归档会将其替换为空目录。

全部成功后才启动服务。如果关闭写入后又发生失败，脚本会再次尝试停止服务。
SQL 提交后的文件替换失败不能自动回滚数据库。应保持应用停止，保留两个目录，恢复与回滚目录配套的数据库后再恢复文件。
需要回滚时，必须事先单独备份恢复前的数据库。此脚本不能读取生产备份的 `rakazo.dump` 或 `appdata.tgz`。

## 生产快照

单虚拟机生产部署使用 `infra/compose/backup-prod.sh`，安装到 `/usr/local/sbin/rakazo-backup`，
并启用配套的 `rakazo-backup.timer`。它在 `/var/backups/rakazo` 创建经过验证的 Postgres 自定义格式备份和应用数据归档，文件权限为 `0600`。
安装步骤见[生产部署（英文）](../self-host-production.md)。

默认保留 `RAKAZO_BACKUP_KEEP=3` 份快照，受 `RAKAZO_BACKUP_MAX_GB=50` GiB 限制，并保留至少
`RAKAZO_BACKUP_MIN_FREE_GB=5` GiB 可用磁盘空间。
脚本先清理遗留的未完成快照和超额历史，再检查容量；空间不足时保留最新的已验证快照，失败时清理该次未完成输出。
仅有本地快照无法应对整台服务器丢失。

默认部署目录是 `/srv/rakazo`。其他目录可在 root 所有、权限为 `0600` 的 `/etc/rakazo/backup.env` 中设置：

```env
RAKAZO_DEPLOY_DIR=/srv/rakazo
RAKAZO_BACKUP_KEEP=3
RAKAZO_BACKUP_MAX_GB=50
RAKAZO_BACKUP_MIN_FREE_GB=5
```

自定义 Compose 项目名时，还要设置相同的 `COMPOSE_PROJECT_NAME`。
更新仓库不会更新 `/usr/local/sbin` 的副本；升级备份工具时需重新安装脚本和服务单元，并运行 `systemctl daemon-reload`。

使用专用备份盘时，应持久挂载该磁盘，并把它的 `backups` 目录 bind mount 到 `/var/backups`。
在 `/etc/fstab` 的 bind 挂载选项中加上 `x-systemd.requires-mounts-for=/mnt/your-backup-volume`。
在 `/etc/rakazo/backup.env` 中设置 `RAKAZO_BACKUP_REQUIRE_VOLUME=1`，并为备份服务添加
`[Unit]` drop-in，写入：

```ini
[Unit]
RequiresMountsFor=/var/backups
AssertPathIsMountPoint=/var/backups
```

这样挂载缺失，或 `/var/backups` 实际指向根文件系统时，脚本会拒绝回退到根存储。

## 加密与异地备份

在自己掌控的另一台机器上生成 age 密钥，不要在服务器上生成或保存私钥：

```bash
age-keygen -o rakazo-backup.key
```

离线保存身份文件（私钥），并考虑为另一位运维人员添加第二个接收者。
服务器需安装 `age`；`harden-host.sh` 会安装它。将公钥填入 `/etc/rakazo/backup.env`：

```env
RAKAZO_BACKUP_AGE_RECIPIENTS=age1exampleprimaryrecipient age1examplerecoveryrecipient
# 也可指定每行一个公钥的文件：
# RAKAZO_BACKUP_AGE_RECIPIENTS_FILE=/etc/rakazo/backup-recipients.txt
```

示例公钥必须替换为实际公钥。设置后，快照包含 `rakazo.dump.age`、`appdata.tgz.age`、`SOURCE_SIZE_KB` 和 `SHA256SUMS`。
数据库和文件流直接进入 age，明文不落盘；验证过程不需要私钥。
未设置接收者时会生成明文并告警；一旦成功生成过加密备份，之后缺少接收者会拒绝备份。
只有明确接受明文风险时才设置 `RAKAZO_BACKUP_ALLOW_PLAINTEXT=1`。

异地备份需要 `rclone`。在同一设置文件中把目标设为任意 rclone 远端和路径，
例如 S3 兼容存储桶或 SFTP 服务器：

```env
RAKAZO_BACKUP_OFFSITE_REMOTE=offsite:rakazo-backups
RAKAZO_BACKUP_OFFSITE_KEEP=14
RCLONE_CONFIG_OFFSITE_TYPE=s3
RCLONE_CONFIG_OFFSITE_PROVIDER=Other
RCLONE_CONFIG_OFFSITE_ENDPOINT=https://s3.example.com
RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=replace-me
RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=replace-me
```

将占位值替换为自己的配置。异地副本必须加密；上传后通过 `rclone check` 校验，最后上传 `SHA256SUMS` 标记完成。
默认保留最新 14 份完整异地快照，与本地保留数量独立。
设置 `RAKAZO_BACKUP_OFFSITE_KEEP=0` 可让存储桶生命周期规则负责删除，此时凭据无需删除权限。
上传失败保留本地快照，但备份服务会失败并触发告警。

## 演练与恢复生产快照

在私钥所在机器取回快照，再运行验证演练；不要将私钥留在服务器：

```bash
rclone copy offsite:rakazo-backups/<stamp> ./<stamp>
bash infra/compose/backup-drill.sh ./<stamp> rakazo-backup.key
```

需要 `age`、`tar`，以及与服务器 Postgres 主版本相同或更新的 `pg_restore`；生产 Compose 当前使用 Postgres 18。
演练检查校验和、解密并验证数据库与归档格式，不会写出明文，也不会恢复活动服务。

实际恢复前，暂停自动部署和更新器，并停止所有数据库和数据卷写入进程。
**不要把应用数据归档直接解压到活动卷上**，否则快照之后创建的文件会残留，与恢复的数据库混在一起。
应先在同一文件系统的干净同级目录解压，保存当前数据库备份和配套文件目录，再恢复数据库并切换目录。
任何步骤失败都应保持应用停止。数据库事务无法覆盖文件目录切换，单独切换文件也不能回滚数据库。

以下命令应在存放身份文件的机器上、同一个 Bash 会话中执行。先替换快照目录和卷名。
`VOLUME` 必须是 API 当前挂载到 `/data` 的数据卷；使用自定义 Compose 项目名时，卷名通常也会不同。

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
  printf '恢复前数据库导出失败。不要使用 %s 这个不完整文件，并保持应用停止。\n' "$ROLLBACK_DUMP" >&2
  exit 1
fi

APPDATA="$(ssh deploy@app.example.com "sudo docker volume inspect -f '{{.Mountpoint}}' '$VOLUME'")"
RESTORE="$(ssh deploy@app.example.com "sudo mktemp -d '${APPDATA%/*}/rakazo-restore.XXXXXX'")"
ssh deploy@app.example.com "sudo mkdir '$RESTORE/staged'"
printf '记录这组回滚路径：\n数据库导出：%s\n远程数据目录：%s/previous\n' \
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

归档必须先成功解包，然后才能开始导入 SQL。干净的临时目录和回滚目录都位于数据卷活动目录的同级，
因此与活动数据在同一文件系统。重建应用容器后，它们会挂载替换后的目录。
`--single-transaction` 会在 SQL 出错时回滚导入，但文件目录切换不在该事务内：
导入提交后，目录切换或启动失败都可能让数据库与活动目录不一致。
如果启动失败，应再次停止 `api worker web`，包括已经启动的容器。

`$ROLLBACK_DUMP` 是权限为 `0600` 的明文数据库回滚副本。`mktemp` 会为每次尝试创建新文件，
不会覆盖已有的 `before-restore.dump`、此前的回滚副本或符号链接目标。导出失败时，命令会在应用仍停止的状态下退出；
打印出的不完整文件不能用于回滚。先保留已有回滚文件对并修复导出错误，再重试恢复。

把打印出的数据库导出路径与对应的远程 `$RESTORE/previous` 目录一起记录，直到验证恢复后的应用为止。
需要回滚目录时不要删除 Docker 卷。若 SQL 已提交后需要回滚，应保持应用停止，把记录的
`$ROLLBACK_DUMP` 恢复到新建的空数据库；先把失败的活动目录移到另一路径以便排查，
再把本次尝试的 `$RESTORE/previous` 移回 `$APPDATA`，最后重建应用容器。
如果第一次目录移动就失败了，旧目录仍在 `$APPDATA`；移动任何内容前先检查两个路径。
只切回文件目录不会回滚数据库。

明文快照没有 `.age` 后缀，应分别用 `cat` 代替 `age -d`，文件名是 `rakazo.dump` 和 `appdata.tgz`；
干净目录与回滚步骤不变。

恢复到新部署时，必须先创建 `rakazo_app` 角色，再执行上述流程。备份会把权限授予该角色，
而新部署只有迁移会创建它，因此缺少角色时 `pg_restore` 会停止。
不要先运行迁移：比快照更新的表会阻止恢复；流程最后启动应用时才会应用迁移。

```bash
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE up -d --wait postgres"
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE exec -T postgres sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"CREATE ROLE rakazo_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE\"'"
```

## 时间点恢复

每晚快照最多可能丢失一天的数据。时间点恢复（PITR）会把数据库的预写日志（WAL）上传到兼容 S3 的对象存储，
并每 24 小时创建一次基础备份，使数据库可以恢复到最近 `PITR_RETAIN_DAYS` 天内的任意时刻
（默认 `7` 天）；服务器完全丢失时，通常只损失约一分钟的写入。
PITR 只覆盖数据库，应用文件仍须依赖每晚快照。它默认关闭，并要求使用 Postgres 18 的生产 Compose。

可选的 `pitr` 服务通过内部 `data` 网络接收 `pg_receivewal` 流，使用只允许复制的登录身份和复制槽，
并从自己的网络上传，因此 Postgres 不需要访问互联网。只要数据库有写入，Postgres 至少每分钟关闭一个 WAL 段
（`archive_timeout`）。每个 WAL 段和基础备份离开容器前都会像每晚快照一样，用 age 加密给公开接收者，
因此服务器无法读取自己的备份；可以复用同一组接收者。

复制槽会保留尚未到达 sidecar 的 WAL，所以重启 sidecar 不会留下缺口。上传阻塞时磁盘占用仍有上限：
sidecar 最多保留 `PITR_MAX_WAL_GB`（默认 `4` GiB）待上传的压缩 WAL，然后暂停接收；
Postgres 为复制槽最多再保留同样大小的 WAL（`max_slot_wal_keep_size`）。超过后 Postgres 会丢弃该复制槽的 WAL，
恢复将出现缺口；sidecar 重连后会创建新的基础备份。

请使用独立存储桶。凭据需要列出、读取、写入和删除对象；删除只用于清理超过保留期的备份。
设置 `PITR_RETAIN_DAYS=0` 时不删除任何内容，因此不需要删除权限，改由存储桶生命周期规则处理过期。
在 `.env` 中加入：

```env
COMPOSE_PROFILES=pitr
PITR_DATABASE_PASSWORD=replace-with-openssl-rand-hex-24
PITR_BUCKET=example-rakazo-pitr
PITR_ENDPOINT=https://s3.example.com
PITR_REGION=example-region
PITR_ACCESS_KEY_ID=replace-me
PITR_SECRET_ACCESS_KEY=replace-me
PITR_AGE_RECIPIENTS=age1exampleprimaryrecipient age1examplerecoveryrecipient
# 可选：PITR_PREFIX（对象键前缀）、PITR_PATH_STYLE=true（路径式存储桶寻址）、
# PITR_RETAIN_DAYS、PITR_MAX_WAL_GB。
```

`COMPOSE_PROFILES` 用逗号分隔；同时启用更新器时写 `updater,pitr`。使用 AWS S3 时不要设置 `PITR_ENDPOINT`。
然后在代码检出目录启用：

```bash
sudo infra/compose/pitr.sh enable
```

该命令会创建 `rakazo_pitr` 复制登录、在 `pg_hba.conf` 中允许它，设置 `archive_timeout` 和
`max_slot_wal_keep_size`，并重新加载 Postgres，不会重启它。随后 sidecar 会创建第一份基础备份。
修改 `PITR_DATABASE_PASSWORD` 或 `PITR_MAX_WAL_GB` 后，以及把 Postgres 移到新集群后，都要再次运行 `enable`。
上传内容按集群的系统标识分组，因此新集群不会覆盖旧集群的 WAL。

上传等待超过十分钟、接收暂停、复制槽没有流，或最近基础备份超过 30 小时时，sidecar 的健康检查会失败。
设置 `RAKAZO_MONITOR_COMPOSE_PROJECT` 后，宿主机检查会对此告警。可查看详细状态：

```bash
sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec pitr rakazo-pitr health
```

任何装有 Docker 且有这份代码的机器都可以执行恢复。身份文件从标准输入传入，只存在于恢复容器内存中。
先验证最近一个恢复点能恢复到临时卷，演练结束后会删除该卷。启用后、修改 PITR 脚本后以及定期都应执行：

```bash
sudo infra/compose/pitr.sh drill < rakazo-backup.key
```

不在服务器上操作时，把 `PITR_ENV_FILE` 指向一个只含 `PITR_` 存储设置的文件。
要把生产环境恢复到某个时刻，先停止所有会写数据库的进程，再恢复到原数据卷。
当前集群会在卷内移到一旁，不会被删除。目标时间按 UTC 解释，除非显式写明时区：

```bash
COMPOSE="sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml"
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE stop api worker web pitr postgres"
ssh deploy@app.example.com \
  "cd /srv/rakazo && sudo infra/compose/pitr.sh restore '2026-01-31 09:41:00+00' rakazo-prod_postgres" \
  < rakazo-backup.key
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE up -d --wait"
```

恢复会选择目标时间之前最近完成的完整基础备份，重放 WAL 到目标时间并提升数据库，从而开启新的时间线；
sidecar 会为它创建新的基础备份。恢复期间应暂停 CI 部署。确认恢复后的数据库无误后，再删除旧集群：

```bash
ssh deploy@app.example.com \
  "cd /srv/rakazo && $COMPOSE run --rm --no-deps --entrypoint sh postgres -c 'rm -rf \"\$PGDATA\".before-restore-*'"
```

关闭 PITR 时，先从 `COMPOSE_PROFILES` 中移除 `pitr`，再运行 `sudo infra/compose/pitr.sh disable`。
这会删除 sidecar、复制槽（Postgres 随即停止为它保留 WAL）、登录身份和设置；已上传的备份仍保留在存储桶中。

## 在不同实例间迁移账号

在不同 Rakazo 实例之间迁移账号，可在旧实例“设置 → 导出数据”，在新实例导入。
导出 ZIP 包含所属空间的机器人、聊天、文件、记忆、例行任务、技能、工作区文件，以及自己拥有空间的看板。
ZIP 中的内容已解密，应保密保存。导入会创建自己拥有的新空间，例行任务默认关闭。
模型密钥和其他连接凭据（包括应用、MCP 服务器和消息集成）不会迁移，需重新连接。
工作区中超过 8 MiB 的文件不会导出；
导出上限为 4 GiB，上传须在服务器请求超时前完成（Node 默认五分钟）。
