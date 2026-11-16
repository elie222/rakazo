# 升级

[English](../self-host-upgrading.md) | 简体中文

更新前先备份数据库、应用数据和部署配置，并确认能恢复。保留原有加密密钥，区分镜像版、源码版与生产 Compose。

## 镜像版安装器

对于使用 `install-images.sh` 安装的实例，在原安装目录保留 `.env`，重新运行安装器。
使用固定版本时，先将 `.env` 中应用镜像和计算机镜像的标签更新到同一个已发布版本：

```bash
bash install-images.sh
```

默认的 `edge` 随主分支移动，不是固定版本。镜像下载受限时，见[受限网络](./self-host-restricted-network.md)。
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

若旧版本无法读取新版本的加密内容，不能只回滚应用镜像；需先按[内容加密迁移（英文）](../content-encryption.md#rollout)执行解密。
行级安全异常的诊断与临时回退方法见[数据库登录升级说明（英文）](../self-host-upgrading.md#upgrading-to-the-separate-app-database-login)。

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

## 镜像标签与回滚

每次发布会生成 `sha-<完整提交号>`；`edge` 跟随主分支；稳定的 `vX.Y.Z` 发布还生成相应版本标签。
自动更新器选择最新稳定源码标签，但部署对应的完整 `sha-` 镜像，不使用可移动的 `latest` 或次版本标签。
注册表标签本身不是内容摘要；需要固定内容的运维人员，可在自动更新器之外使用经过验证的镜像摘要。

从自己的 fork 部署时，必须把 `RAKAZO_IMAGE` 和 `RAKAZO_UPDATER_IMAGE` 指向自己的命名空间；
fork 的 CI 无法把镜像发布到别人的命名空间。应用和更新器分别用 `RAKAZO_IMAGE_TAG` 与
`RAKAZO_UPDATER_IMAGE_TAG` 固定，不能靠 `latest` 之类的可移动标签完成可重复升级。

首次填充注册表时，可手动运行发布工作流或推送 `v*` 标签。手动运行生成 `sha-<完整提交号>`；
只有不带预发布后缀的稳定 `vX.Y.Z` 标签会生成 `latest`。自动更新器会忽略预发布版本，
在存在稳定 `vX.Y.Z` 之前拒绝使用官方更新路径。

更新器回滚只使用本机缓存，不从注册表重新拉取。因此接受下一次更新前不要清理上一个应用镜像，
缓存缺失时回滚会拒绝继续，而不会在旧标签下拉取可能已变化的内容。

## 可选自动更新器

生产 Compose 的 `updater` 配置默认关闭，手动更新不需要启用。
启用前设置独立的随机 `RAKAZO_UPDATER_TOKEN`（生产环境至少 32 字符），
不得复用认证、监督服务或屏幕代理密钥：

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater up -d --build updater
```

更新器使用独立镜像，不会重建自己，也不更改 Postgres 或 Caddy。
迁移顺序由 API 对 `migrate` 的依赖控制。
拉取失败不影响正在运行的服务；重建失败会尽可能恢复旧环境和缓存镜像，但不会撤销迁移。

更新器在私有 `control` 网络的 `http://updater:7092` 上提供 `/health`、`/state`、`/plan`、`/apply`
和 `/rollback`。除 `/health` 外，所有接口都要求 `RAKAZO_UPDATER_TOKEN`；仅部署工具应调用它们。
普通应用账号没有更新接口，应用 API 也不会拿到更新令牌。

官方路径会用 `git ls-remote --tags` 找到最新稳定发布及其源码提交，把对应的完整
`sha-<提交号>` 镜像标签写入 `.env`，把旧标签保存在 `RAKAZO_IMAGE_TAG_PREVIOUS`，
显式拉取新镜像后执行 `up -d --wait --pull never`，服务器不构建镜像。
Fork 模式没有已发布镜像，会快进 `RAKAZO_DEPLOY_DIR` 中的代码并执行 `up -d --build`，
因此会花几分钟在服务器上构建。只应把 Fork 模式指向自己掌控且审查过的仓库，因为它会通过
root 权限等价的 Docker 套接字执行该 Compose 文件。

更新和回滚一次只运行一个。Fork 构建失败还会恢复更新前的分支和提交；即使代码已成功检出但合并失败也一样。
Git 远端只接受 `https://` 和 `ssh://`，且只允许快进合并；工作树有未提交或未跟踪文件时会在执行前拒绝继续。

**更新器持有 Docker 套接字，权限相当于宿主机 root。** 它只在私有控制网络提供带令牌验证的接口；
不要将其端口对外发布。普通应用账号没有更新接口，应用 API 也不持有更新令牌。
更新器容器没有发布任何宿主机端口，未接入 Caddy，进程环境只包含更新器设置；
应用密钥留在 Compose 读取的挂载 `.env` 中，不会加载到更新器容器。API、worker 和 web 仍没有 Docker 套接字。
`RAKAZO_UPDATER_TOKEN` 还必须不同于 `BETTER_AUTH_SECRET`、`SANDBOX_SUPERVISOR_TOKEN` 和
`SCREEN_PROXY_SECRET`；不需要自动更新时可一直保持该 profile 关闭。

`RAKAZO_DEPLOY_DIR` 必须是 Docker 守护进程看到的实际路径，宿主机与更新器内使用同一路径。
生产 Compose 默认两侧都是 `/srv/rakazo`；其他目录必须显式设置。Linux 上守护进程共享宿主文件系统，
通常填写代码检出目录即可。Docker Desktop 的守护进程运行在虚拟机中，路径会不同：
Windows 的 `C:` 通常对应 `/run/desktop/mnt/host/c`，所以 `C:\Users\you\rakazo` 应设为
`RAKAZO_DEPLOY_DIR=/run/desktop/mnt/host/c/Users/you/rakazo`。
不要填写 Windows 原生路径（守护进程会因盘符冒号拒绝），也不要使用 `/mnt/c/...`；
后者可能静默挂载为空目录。部署前先验证：

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater run --rm updater \
  sh -c 'git -C "$RAKAZO_DEPLOY_DIR" log --oneline -1'
```

命令必须打印代码检出的当前 HEAD。宿主 Git 使用 `core.autocrlf=true` 不影响 `/apply`，
更新器会忽略仅由 CR 引起的差异。使用自定义 `-p` 项目名时，还要让更新器看到同一个项目名：
生产 Compose 会传递 `COMPOSE_PROJECT_NAME`；独立运行更新器时可设置 `RAKAZO_COMPOSE_PROJECT_NAME`，
最后才回退到 `rakazo-prod`。否则更新器可能避开原部署，另起一个带空 Postgres 卷的第二个项目。

叠加其他 Compose 文件时，用 `RAKAZO_COMPOSE_FILE` 按相同顺序列出全部文件，分隔符与 Compose 的
`COMPOSE_FILE` 一致（默认 `:`，或由 `COMPOSE_PATH_SEPARATOR` 指定）：

```env
RAKAZO_COMPOSE_FILE=infra/compose/docker-compose.prod.yml:infra/compose/docker-compose.prod.docker.yml
```

每个文件都会单独校验，且必须位于 `RAKAZO_DEPLOY_DIR` 内。如果叠加文件新增了使用应用镜像的服务，
把该服务加入逗号分隔的 `RAKAZO_UPDATE_SERVICES`，让它随应用一起拉取、重建和回滚，例如：

```env
RAKAZO_UPDATE_SERVICES=supervisor
```

这些名称只会追加到内置的 `api`、`worker`、`web`，不会替换核心服务，因此不会因配置遗漏而跳过更新。
