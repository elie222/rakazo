# 自托管 Rakazo

[English](../self-host.md) | 简体中文

在自己掌控的机器上运行 API、后台任务、网页应用、数据库和机器人计算机。
Rakazo 需要持续运行的后端服务，不是静态网站；`apps/www` 中的官网可以单独托管。

## 准备条件

- Docker Engine 26 或更新版本（API 1.45+）、Compose 插件、curl 和 OpenSSL。使用已发布镜像时不需要 Node.js。
- 可用的模型：注册后在应用中连接提供商，或使用自己运行的模型服务器，见[模型接入](./self-host-models.md)。
- 对公网提供服务时，需要域名和 TLS，见[生产部署（英文）](../self-host-production.md)。

## 已发布镜像（无需检出源码）

在空目录中运行：

```bash
mkdir -p rakazo && cd rakazo &&
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh &&
bash install-images.sh
```

安装器下载 `docker-compose.images.yml` 和 `.env.images.example`，生成包含随机密钥的 `.env`，然后拉取并启动镜像。
再次运行会保留已有的 `.env`。密钥要求与恢复方法见[密钥清单（英文）](../self-host-secrets.md)。

如需先配置公开地址、镜像标签或可选提供商：

```bash
bash install-images.sh --prepare-only
# 编辑 .env 后启动
bash install-images.sh
```

当 `RAKAZO_IMAGE_TAG` 为 `v0.8.0` 这样的发布版本时，安装脚本会从该版本而不是 `main` 下载 Compose 文件。

`SANDBOX_PROVIDER` 默认为 `docker`，无需远程计算机服务账号即可使用本地 Docker 计算机。
镜像版 Compose 会在内部网络运行沙箱监督服务，并拉取计算机镜像。
远程计算机的选择与密钥配置见[计算机提供商（英文）](../self-host-sandbox-providers.md)。
无论选择哪种提供商，这套 Compose 都要求配置 `SANDBOX_SUPERVISOR_TOKEN`；留空会拒绝启动。

默认镜像标签是 `edge`，随主分支更新；发布的镜像同时支持 `amd64` 和 `arm64`。
不要假定仓库中一定存在 `latest` 标签。固定版本与更新方法见[升级](./self-host-upgrading.md)。

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)，注册并连接模型。注册账号不会自动获得服务器管理权限。
在机器人中打开计算机，或发送需要使用桌面的消息，即可启动本地 Docker 计算机。

### 公网访问

镜像版默认只在回环地址 `127.0.0.1:5173` 监听。在宿主机上配置 TLS 反向代理，例如：

```Caddyfile
app.example.com {
	reverse_proxy 127.0.0.1:5173
}
```

在 `.env` 中将 `BETTER_AUTH_URL`、`WEB_ORIGIN` 和 `API_URL` 都设为同一个 HTTPS 来源地址，
并将 `RAKAZO_HOST` 设为其主机名，例如 `app.example.com`。Cookie 和跨域检查使用这些地址。
网页服务会将 `/api` 和 `/rpc` 代理到后端，不要将 `3100` 端口暴露到公网。
如需 Compose 内置 Caddy 或完整的主机加固流程，使用[生产部署指南（英文）](../self-host-production.md#public-single-vm-deployment)。

### 受限网络

安装脚本、Compose 文件或镜像无法下载时，见[受限网络与镜像下载](./self-host-restricted-network.md)。
下载镜像设置不会自动解决模型和远程计算机提供商的网络访问问题。

## 从源码运行

需要 Node.js 22.x（至少 22.23.4）、24.x 或 26 及以上版本、pnpm 12 和 Docker；不支持 Node.js 23.x 和 25.x。
从仓库根目录开始：

```bash
cp .env.example .env
```

将 `POSTGRES_PASSWORD` 和 `POSTGRES_APP_PASSWORD` 分别设为 `openssl rand -hex 16` 生成的值，
并填入 `DATABASE_MIGRATION_URL` 和 `DATABASE_URL`。
为 `BETTER_AUTH_SECRET`、`ENCRYPTION_KEY`、`SCREEN_PROXY_SECRET` 和 `SANDBOX_SUPERVISOR_TOKEN`
分别生成至少 32 个字符的独立密钥；`ENCRYPTION_KEY` 使用 64 个十六进制字符。已有安装必须保留原密钥，否则已存储的凭据可能无法解密。

```bash
pnpm install
pnpm sandbox:build
pnpm dev
```

打开终端打印的地址，默认是 `http://127.0.0.1:5173`。`pnpm dev` 会先准备数据库并应用迁移。
开发服务运行时，可用 `pnpm --filter @rakazo/desktop dev` 启动桌面端，并选择“已有实例”。
桌面端的“本机”选项会自行安装镜像版服务，默认使用 `45173` 端口，与开发服务不同。

在 WSL 中开发时，将仓库和 `data` 放在 Linux 文件系统中，例如 `~/rakazo`，并以普通用户运行。
宿主机运行的监督服务会让机器人容器使用该用户的 UID/GID。
若无法访问 Docker Desktop 容器 IP，在 `.env` 中设置 `SANDBOX_CONTROL_VIA_LOOPBACK=true`；
Compose 内运行监督服务时不要设置此项。

## 使用源码版 Compose

准备好 `.env` 后，也可以在仓库根目录运行：

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml up --build
```

Postgres 默认仅在 Compose 内部网络开放。密码宜使用无需 URI 转义的字符，例如随机十六进制字符串。
已有数据卷保留首次初始化时的用户、密码和数据库；仅修改 `.env` 不会更改数据库中的密码。
不要用 `docker compose down -v` 排障，它会删除数据库状态。需要从宿主机连接时，使用
`infra/compose/docker-compose.postgres-host.yml` 叠加配置，仅开放回环端口，见[英文说明](../self-host.md#docker-compose-single-machine)。

## 配置与运维

- [模型接入、审批与语音](./self-host-models.md)
- [备份与恢复](./self-host-backups.md)
- [升级](./self-host-upgrading.md)
- [受限网络与镜像下载](./self-host-restricted-network.md)
- [配置](../self-host-configuration.md)、[账号与登录](../self-host-accounts.md)、[工具集成](../self-host-integrations.md)（英文）
- [存储与加密](../self-host-storage.md)、[日志与监控](../self-host-observability.md)、[客户端](../self-host-clients.md)（英文）

## 报告问题

镜像版可以生成诊断报告，附到[自托管问题](https://github.com/elie222/rakazo/issues/new?template=self-host.yml)中：

```bash
docker compose -f docker-compose.images.yml exec api node dist/cli/diagnostics.js
```

源码版改用 `-f infra/compose/docker-compose.yml`，生产部署使用对应的生产文件。
报告包含版本、功能开关、迁移状态、MCP 健康状态与最近运行情况；不会输出密钥、设置值、姓名、地址、路径或消息内容。
用户让机器人报告问题时，反馈只保存在本服务器的 `feedback_reports` 表中，不会自动发送给 Rakazo 项目。
