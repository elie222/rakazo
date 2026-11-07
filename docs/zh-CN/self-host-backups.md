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
专用备份盘的挂载检查配置见[生产备份（英文）](../self-host-backups.md#production-backups)。

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

异地备份需要 `rclone`，在同一设置文件中配置目标，例如：

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

生产恢复命令依赖实际 Compose 项目名和 `/data` 挂载的数据卷，必须先核对并替换占位值，再按照
[加密快照恢复完整步骤（英文）](../self-host-backups.md#restoring-an-encrypted-backup)执行。
新实例应先创建 `rakazo_app` 角色，不要先运行会创建新表的迁移；最终启动时会应用迁移。

## 时间点恢复与账号迁移

每晚快照最多可能丢失一天的数据。可选 PITR 通过加密 WAL 和每日基础备份恢复数据库到指定时间，
默认保留七天，默认关闭，需使用 Postgres 18 的生产 Compose。
它只覆盖数据库，应用文件仍需快照。启用、容量限制、演练与恢复见[时间点恢复（英文）](../self-host-backups.md#point-in-time-recovery)。

在不同 Rakazo 实例之间迁移账号，可在旧实例“设置 → 导出数据”，在新实例导入。
导出 ZIP 包含所属空间的机器人、聊天、文件、记忆、例行任务、技能、工作区文件，以及自己拥有空间的看板。
ZIP 中的内容已解密，应保密保存。导入会创建自己拥有的新空间，例行任务默认关闭。
模型密钥和其他连接凭据不会迁移，需重新连接。工作区中超过 8 MiB 的文件不会导出；
导出上限为 4 GiB，上传须在服务器请求超时前完成（Node 默认五分钟）。
