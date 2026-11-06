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

跨越 `20260830200000_space_scope_names_and_user_credentials` 的旧安装，还需按
[空间隐私边界迁移检查（英文）](../self-host-upgrading.md#space-privacy-boundary-migration)验证凭据归属，不能跳过停机要求。

## 镜像标签与回滚

每次发布会生成 `sha-<完整提交号>`；`edge` 跟随主分支；稳定的 `vX.Y.Z` 发布还生成相应版本标签。
自动更新器选择最新稳定源码标签，但部署对应的完整 `sha-` 镜像，不使用可移动的 `latest` 或次版本标签。
注册表标签本身不是内容摘要；需要固定内容的运维人员，可在自动更新器之外使用经过验证的镜像摘要。

更新器回滚只使用本机缓存，不从注册表重新拉取。因此接受下一次更新前不要清理上一个应用镜像，
缓存缺失时回滚会拒绝继续，而不会在旧标签下拉取可能已变化的内容。
完整发布机制见[镜像与标签（英文）](../self-host-upgrading.md#published-images-and-tags)。

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

**更新器持有 Docker 套接字，权限相当于宿主机 root。** 它只在私有控制网络提供带令牌验证的接口；
不要将其端口对外发布。普通应用账号没有更新接口，应用 API 也不持有更新令牌。
Fork 模式会在服务器构建仓库，只能指向自己掌控且审查过的代码。

`RAKAZO_DEPLOY_DIR` 必须是 Docker 守护进程看到的实际路径，宿主机与更新器内使用同一路径。
Linux 默认是 `/srv/rakazo`；Docker Desktop 的路径可能与终端中的路径不同，
必须先验证挂载。多个 Compose 叠加文件和额外服务也须显式配置，详见
[更新器部署路径与权限（英文）](../self-host-upgrading.md#the-deploy-directory-must-be-one-path)。
