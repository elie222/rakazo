# 升级

[English](../self-host-upgrading.md) | 简体中文

将部署迁移到新版本、处理一次性迁移，并可选择让更新器 sidecar 代为执行。更新前先[备份并演练](./self-host-backups.md)，确认能恢复，并保留原有加密密钥。

## 镜像版安装器

对于使用 `install-images.sh` 安装的实例，在原安装目录保留 `.env`，重新运行安装器。
使用固定版本时，先将 `.env` 中应用镜像和计算机镜像的标签更新到同一个已发布版本：

```bash
bash install-images.sh
```

新安装默认使用 `latest`，仅跟随稳定发布，不是固定版本；必须已有稳定发布版本，安装器不会回退到主分支构建。
安装器会保留已有 `.env` 中的标签。镜像下载受限时，见[受限网络](./self-host-restricted-network.md)。
桌面端托管的本地实例由桌面应用管理，不要将生产 Compose 命令直接套到桌面端的数据目录。

## 生产 Compose

先把 `.env` 中的 `RAKAZO_IMAGE_TAG` 改为目标发布标签，再拉取并重建应用服务：

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml pull api worker web
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never api worker web
```

默认使用 `local` 标签的部署没有可拉取的仓库镜像，应更新源码并重新构建：

```bash
git pull
GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never --build api worker web
```

`--wait` 会等待新 API 健康、worker 和网页容器运行。Compose 停止旧 worker 时会等待正在执行的任务完成，
最长 50 分钟；新 worker 启动后才开始新任务。API 要等 `migrate` 成功后才启动，迁移失败会阻止新 API 启动。
命令行重建失败不会自动回滚，应恢复上一个镜像标签（或重建旧的 `local`），再执行启动命令。
数据库迁移不会随应用回滚自动撤销。

不使用 Compose 的源码部署，应拉取代码，带 `GIT_SHA=$(git rev-parse HEAD)` 重新构建，执行 `pnpm db:migrate`，
然后重启 API 和 worker。

更新器容器（sidecar）使用自己的镜像和标签，因此升级应用时不会重建执行更新的进程。
需要升级更新器时，明确把 `RAKAZO_UPDATER_IMAGE_TAG` 设为完整的 `sha-<提交号>` 标签，再运行：

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml pull updater
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never updater
```

更新器的 `/apply` 和 `/rollback` 在重建失败时会尽量重新部署缓存中的旧镜像；
如果这也失败，会报告运行时可能处于混合版本。

## 独立数据库登录身份

使用独立应用数据库角色的版本需要 `.env` 中的 `POSTGRES_APP_PASSWORD`。
桌面端、镜像安装器、更新器和 `deploy-main.sh` 会在缺失时补充；其他部署应在更新前自行生成，例如 `openssl rand -hex 16`。
缺失时 Compose 会在配置验证阶段停止。首次启动会创建 `rakazo_app`，API 和 worker 随后使用它连接。
若功能在行级安全下异常，可在 `DATABASE_URL` 对应登录（Compose 中为 `rakazo_app`）上由超级用户执行
`ALTER ROLE <login> BYPASSRLS;`，然后重启 API 与 worker。撤销使用 `NOBYPASSRLS` 并重启，再在日志中搜索
`violates row-level security` 与 `without a tenant or system context`。

若旧版本无法读取新版本的加密内容，不能只回滚应用镜像；需先按[内容加密迁移（英文）](../content-encryption.md#rollout)执行解密。
同日发布版本还会在库内加密内容：回滚到更早版本前须先运行 `content-encryption decrypt`。

## Postgres 18 迁移

生产与源码 Compose 使用 Postgres 18；旧安装可能仍有 Postgres 16 的 `pgdata` 卷，不能直接由 Postgres 18 打开。
迁移完成前，数据库容器会退出，生产部署会在替换应用之前停止，不会删除旧数据或自动创建空实例。
镜像版的 `docker-compose.images.yml`（包括桌面端）仍使用 Postgres 16，不需要套用此迁移。

先[备份并演练](./self-host-backups.md)，再在生产服务器运行：

```bash
cd /srv/rakazo
git pull --ff-only
sudo infra/compose/upgrade-postgres.sh
```

自定义 Compose 文件或项目名时，需要传入部署使用的全部文件，并设置相同的 `COMPOSE_PROJECT_NAME`。
例如源码版：

```bash
sudo RAKAZO_DEPLOY_DIR="$PWD" infra/compose/upgrade-postgres.sh infra/compose/docker-compose.yml
```

受限网络需设置旧版镜像的 `RAKAZO_POSTGRES_16_IMAGE`，此时 `POSTGRES_IMAGE` 应指向 Postgres 18。
脚本会停止服务、复制角色和数据库，并验证权限、策略、序列、行数和应用角色登录后才切换。
整个复制过程会停机。可用磁盘空间至少为旧数据库数据目录占用量的 125%，再加 1 GiB，
即一份完整副本、其大小的 25% 余量，以及额外 1 GiB，与升级脚本的容量检查一致。
失败时服务保持停止，旧数据不变；修复后可重试，成功后再次运行不会重复迁移。
生产部署若因数据库升级检查而停止，迁移完成后必须重新运行先前停止的部署；
升级脚本只恢复原先运行的服务，不会部署目标应用版本。未使用部署脚本的源码 Compose 安装按上面的方式继续升级应用。

旧卷会保留。回滚旧版本只能看到升级前的数据，Postgres 18 中的新写入不会返回旧卷。
如需回滚应立即进行，并暂停自动部署；只有确认不再需要回滚时才能清理旧卷。
完整迁移与清理说明见[Postgres 18 升级（英文）](../self-host-upgrading.md#upgrading-to-postgres-18)。

## 空间隐私边界迁移

跨越迁移 `20260830200000_space_scope_names_and_user_credentials` 的旧安装，必须先确认每个现有模型和语音凭据
仍属于其空间成员。以下查询使用迁移前的 `workspaceId` 列名，结果必须为零行：

```sql
SELECT 'model' AS credential_type, credential."id", credential."userId",
       credential."workspaceId" AS "spaceId"
FROM "user_model_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL
UNION ALL
SELECT 'voice', credential."id", credential."userId", credential."workspaceId"
FROM "user_voice_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL;
```

该迁移会重命名 API 和 worker 使用的列，因此必须协调切换，不能在线滚动迁移。
停止旧的 API 和 worker，应用迁移后同时启动新版本。迁移的锁等待有上限：
遇到竞争时会让迁移失败，而不是让应用流量无限排队。

## 2026 年 10 月 30 日前连接的集成

2026 年 10 月 30 日前通过 Pipedream 连接的集成只保存了应用名称，没有保存登录的是哪个账号。
此后的版本只使用注明了账号的连接，因此这些应用不会为机器人提供工具；机器人首次尝试使用时，会请用户重新连接。
如需提前找出它们，请运行：

```sql
SELECT "id", "spaceId", "provider" FROM "connections"
WHERE "connectorId" = 'pipedream' AND "status" = 'connected' AND "providerRef" = "provider";
```

在各自空间的 Integrations 页面重新连接列出的每个应用。系统不会自动回填，
因为一个空间可能为同一应用连接了多个账号。

## 已发布镜像与标签

`.github/workflows/publish-server-image.yml` 将镜像发布到 `ghcr.io/<owner>/<repo>/…`，由 `${{ github.repository }}` 推导，
因此 fork 的 CI 会写入 fork 自己的命名空间。本仓库为：

| 镜像                              | 内容                                                |
| --------------------------------- | --------------------------------------------------- |
| `ghcr.io/elie222/rakazo/app`      | api、worker、web 与沙箱监督进程，同一镜像、不同命令 |
| `ghcr.io/elie222/rakazo/computer` | 用作各机器人计算机的 Linux 桌面                     |
| `ghcr.io/elie222/rakazo/updater`  | 更新器 sidecar，并包含 Docker CLI                   |

`infra/compose/docker-compose.images.yml` 是无需检出仓库即可使用上述应用与计算机标签以及 Postgres 的路径。
监督进程从应用镜像在内部网络运行（无单独发布的监督镜像，也不映射主机端口）。生产 Compose（`docker-compose.prod.yml`）
在将 `RAKAZO_IMAGE_TAG` 设为已发布标签后也可拉取相同应用标签。

从自己的 fork 部署时，将 `RAKAZO_IMAGE` 与 `RAKAZO_UPDATER_IMAGE` 指向自己的命名空间；
fork 的 CI 无法发布到他人的命名空间。

| 标签                 | 何时发布                           | 是否会移动                      |
| -------------------- | ---------------------------------- | ------------------------------- |
| `local`              | 无，由 `up --build` 在本地构建     | 原地重建                        |
| `local-<完整提交号>` | 无，由 fork 更新在服务器构建       | 否                              |
| `vX.Y.Z`、`vX.Y`     | 发布标签                           | 惯例上 minor/patch 策略不变     |
| `latest`             | 仅稳定 `vX.Y.Z`（不含预发布）      | 是，指向最新稳定发布            |
| `sha-<完整提交号>`   | 每次 main 提交、发布标签与手动运行 | 按源码寻址；更新器 sidecar 使用 |
| `edge`               | 推送到 main                        | 是，指向最新 main 构建          |

每次发布（含 main 合并产生的 `edge`）均为多架构（`amd64` + `arm64`）。在配置 `DEPOT_PROJECT_ID`
时使用 Depot 原生构建，否则使用 GitHub 运行器；每个镜像组装一份 manifest。发布 CI 在稳定 `vX.Y.Z`
出现前，GHCR 可能只有 `edge` 与 `sha-*` 标签；除非注册表中确实存在 `latest`，否则不要固定 `latest`。

`docker compose up --build` 按宿主机架构构建，无需 QEMU。更新器选择最新稳定 `vX.Y.Z` 源码标签，
但部署对应的完整 `sha-<提交号>` 镜像，而不是 `latest` 或可移动的次版本标签。回滚不访问注册表：
仅重新部署本地 Docker 缓存中的上一标签，因此在接受下一次更新前不要清理上一应用镜像。

## 更新器 sidecar

生产 Compose 提供可选的 `updater` profile，运行在私有 `control` 网络。默认部署不启动它，也不需要其凭据。
启用时设置独立的 `RAKAZO_UPDATER_TOKEN` 并显式启动 profile：

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater up -d --build updater
```

在 `http://updater:7092` 暴露 `/health`、`/state`、`/plan`、`/apply`、`/rollback`，
使用 `RAKAZO_UPDATER_TOKEN` 认证。上述命令行升级不需要 sidecar；它用于通过私有 HTTP API 自动应用/回滚。
仅部署工具应调用这些接口；应用账号没有更新端点，应用 API 也不会收到更新器令牌。

API 无法自行更新：其镜像内没有 `.git`，容器内也没有机制重启自身。因此工作在独立的 `updater` 容器中完成：

- _官方仓库：_ 用 `git ls-remote --tags` 解析最新稳定发布及其源码提交，在 `.env` 中固定完整 `sha-<提交号>`
  镜像标签，将旧标签保存在 `RAKAZO_IMAGE_TAG_PREVIOUS`，显式拉取新镜像后执行 `up -d --wait --pull never`；服务器上不构建。
- _Fork（高级）：_ fork 没有已发布镜像，sidecar 在 `RAKAZO_DEPLOY_DIR` 中快进检出并执行 `up -d --build`，
  需数分钟。仅指向你控制且已审查的 fork，因为 sidecar 通过 root 等价的 Docker 套接字运行该 Compose 文件。

更新与回滚串行执行。拉取失败不影响正在运行的服务；重建失败会恢复先前的环境固定值并尝试部署缓存中的旧镜像。
Fork 构建失败也会恢复更新前的分支与提交。数据库迁移不会逆向执行。sidecar 从不重建自身，不触碰 Postgres 或 Caddy，
也不运行迁移，该顺序由 API 对 `migrate` 的依赖保证。仅接受 `https://` 与 `ssh://` 远端；合并仅快进；
工作树脏或未跟踪会在执行前拒绝继续。

## 定时稳定版更新 {#scheduled-stable-updates}

> **说明：** 以下能力在合并 [PR #5042](https://github.com/elie222/rakazo/pull/5042) 后与英文版一致；合并前仓库可能尚无 `RAKAZO_AUTO_UPDATE_INTERVAL_HOURS` 等配置项。

生产 Compose 与无需检出的 `docker-compose.images.yml` 均提供可选的 `updater` profile。**仅启动 profile 不会启用定时调度**；
它会授予 root 等价的 Docker 访问权限，除非需要更新工具，否则保持关闭。

在 Linux 上使用已发布镜像安装时，在宿主机 `.env` 中加入：

```dotenv
COMPOSE_PROFILES=updater
RAKAZO_DEPLOY_DIR=/srv/rakazo
RAKAZO_AUTO_UPDATE_INTERVAL_HOURS=6
```

`RAKAZO_DEPLOY_DIR` 使用 Docker 守护进程可见的绝对路径；Docker Desktop 见下文「部署目录」一节。
新安装由安装器生成 `RAKAZO_UPDATER_TOKEN`；旧安装可追加专用令牌（勿打印到终端）：

```bash
printf '\nRAKAZO_UPDATER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
```

若堆栈使用叠加文件，将 `RAKAZO_COMPOSE_FILE` 设为与手工操作时相同的文件列表，例如
`docker-compose.images.yml:docker-compose.override.yml`。镜像堆栈会拉取计算机镜像并默认重建一次性拉取桩与监督进程；
已有机器人计算机保持运行。随后在部署目录启动更新器：

```bash
docker compose --env-file .env -f docker-compose.images.yml up -d updater
docker compose --env-file .env -f docker-compose.images.yml logs --tail 50 updater
```

源码检出应使用生产 Compose 文件，而非开发用 `docker-compose.yml`。启用定时前须先按上文手动流程迁移到已发布稳定应用镜像；
运行中镜像的字节须与缓存的源码提交镜像一致。源构建或覆盖镜像需手工迁移；更新器不会把此类字节指认为共享的稳定发布标签。

然后使用 `-f infra/compose/docker-compose.prod.yml --profile updater` 启动更新器，并按上文说明构建或显式拉取其镜像。
勿在已由 CI 部署管理的服务器上启用定时更新。

首次检查在启动约六小时后运行，此后每次检查完成后再过六小时运行。有效区间为 1–168 整小时；`0` 关闭调度。
检查仅使用官方仓库最新稳定 `vX.Y.Z` 标签，解析为完整源码提交镜像标签，并走现有 apply/健康检查/恢复路径。
预发布与 main 构建从不自动调度。自定义镜像仓库会关闭调度（启动警告与 `/state` 中的 `autoUpdateDisabledReason`）；
手动控制仍可用。更换计算机镜像仓库属于运维迁移：在用更新器控制前，用新仓库重建监督进程并验证匹配镜像；
更新器拒绝与其配置仓库不一致的运行中监督进程。已是最新版本时不重建服务。

**定时更新跟随稳定源码提交，不跟随注册表摘要变化。** 同一提交的镜像重建或重新发布不会触发部署；
需从新提交发布新的稳定版本才会自动滚动。

暂停调度：在 `.env` 中设 `RAKAZO_AUTO_UPDATE_INTERVAL_HOURS=0` 后执行相同的 `up -d updater`。
手工回滚前应先暂停，否则下一次定时检查会再次应用较新发布。`/state` 报告 `autoUpdateIntervalHours` 与上次更新结果；
调度关闭时仍可使用 `/apply` 与 `/rollback`。计算机桩使用 `pull_policy: missing`，因此普通拉取与安装器重跑会复用本地缓存的回滚镜像。
详情与容器内调用示例见[英文升级指南](../self-host-upgrading.md#scheduled-stable-updates)。

## 部署目录必须是同一路径

`RAKAZO_DEPLOY_DIR` 以相同路径绑定挂载进更新器（`${RAKAZO_DEPLOY_DIR}:${RAKAZO_DEPLOY_DIR}`），这是负载相关而非仅为整洁。
生产 Compose 默认两侧为 `/srv/rakazo`；其他布局须显式设置。更新器在容器内执行 `docker compose` 时，
本文件中的相对绑定挂载（`../../.env`、`./Caddyfile.prod` 等）相对该路径展开；守护进程必须能解析相同字符串，
否则会静默创建空目录。须将 `COMPOSE_PROJECT_NAME` 传入更新器；独立 sidecar 可设 `RAKAZO_COMPOSE_PROJECT_NAME`，
否则回退为 `rakazo-prod`。

- **Linux：** 守护进程与宿主共享文件系统，检出路径即可，例如 `/srv/rakazo`。
- **Docker Desktop（Windows/macOS）：** 守护进程在虚拟机中，`C:` 在 Windows 上常映射为 `/run/desktop/mnt/host/c`，
  因此 `C:\\Users\\you\\rakazo` 应设为 `RAKAZO_DEPLOY_DIR=/run/desktop/mnt/host/c/Users/you/rakazo`。
  勿用 Windows 原生路径（盘符冒号会导致 `mount denied`），勿用 `/mnt/c/...`（可能静默为空目录）。

部署前验证：

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater run --rm updater \
  sh -c 'git -C "$RAKAZO_DEPLOY_DIR" log --oneline -1'
```

须打印检出目录的当前 HEAD。宿主 Git 的 `core.autocrlf=true` 不阻止 `/apply`（更新器忽略仅 CR 差异）。

## 叠加 Compose 文件

`RAKAZO_COMPOSE_FILE` 接受列表，分隔符与 Compose 的 `COMPOSE_FILE` 相同（默认 `:`，或由 `COMPOSE_PATH_SEPARATOR` 指定）。
每项成为独立的 `--file`，顺序与配置一致，使更新器调和与运维手工相同的堆栈：

```env
RAKAZO_COMPOSE_FILE=infra/compose/docker-compose.prod.yml:ops/compose/overlay.yml
```

每项单独校验且须位于 `RAKAZO_DEPLOY_DIR` 内。若叠加文件新增由应用镜像构建的服务，
在逗号分隔的 `RAKAZO_UPDATE_SERVICES` 中命名（例如 `supervisor`），以便随应用一起拉取、重建与回滚。
这些名称**追加**到内置的 `api`、`worker`、`web`，不会替换它们。

## 更新器的权限

更新器持有 Docker 套接字，在宿主机上等同于 root。范围尽可能收窄：

- 无 `ports`，不向宿主发布端口。
- 仅在与 API 共享的专用 `control` 网络；Caddy 未接入，反向代理无路由到更新器。
- 除 `/health` 外，所有路由需共享 bearer 令牌，常数时间比较。
- 进程环境仅含更新器设置；应用密钥留在 Compose 读取的挂载 `.env` 中，不加载进本容器。
- Docker CLI 仅存在于更新器镜像；api、worker、web 保持 `cap_drop: ALL` 且无套接字。

启用 `updater` profile 要求 `RAKAZO_UPDATER_TOKEN` 为独立随机值（生产至少 32 字符），
且不同于 `BETTER_AUTH_SECRET`、`SANDBOX_SUPERVISOR_TOKEN` 与 `SCREEN_PROXY_SECRET`。
若不愿授予该能力，请保持 profile 关闭。
