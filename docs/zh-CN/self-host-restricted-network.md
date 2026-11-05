# 受限网络与镜像下载

[English](../self-host-restricted-network.md) | 简体中文

GitHub 或容器注册表无法访问时，可以使用自己掌控的镜像源或预先复制文件。
这些设置只改变下载路径，模型和远程计算机提供商仍需可用的网络连接。

| 失败位置 | 设置或处理方式 |
| --- | --- |
| 安装脚本 | 从可信镜像下载或复制到本地 |
| Compose 文件 | `RAKAZO_DOWNLOAD_BASE`、`--local` 或 `RAKAZO_DOWNLOAD_SKIP_EXISTING=1` |
| 应用或计算机镜像 | `RAKAZO_IMAGE`、`RAKAZO_IMAGE_TAG`、`RAKAZO_COMPUTER_IMAGE`、`RAKAZO_COMPUTER_IMAGE_TAG` |
| Postgres 或 busybox 镜像 | `POSTGRES_IMAGE`、`BUSYBOX_IMAGE`，或 Docker 的 `registry-mirrors` |

## 安装脚本与 Compose 文件

raw GitHub 不可用时，将以下示例地址替换为自己的可信 HTTPS 镜像地址：

```bash
export RAKAZO_INSTALLER_URL=https://example.com/mirror/rakazo/infra/compose/install-images.sh
export RAKAZO_DOWNLOAD_BASE=https://example.com/mirror/rakazo/infra/compose
mkdir -p rakazo && cd rakazo &&
curl -fsSL -o install-images.sh "${RAKAZO_INSTALLER_URL}" &&
bash install-images.sh --prepare-only
```

`RAKAZO_INSTALLER_URL` 供这条 curl 命令下载脚本，`RAKAZO_DOWNLOAD_BASE` 决定脚本下载 Compose 文件的位置。
GitHub 完全受阻时，两者都要设置。地址末尾的斜杠会被移除，不接受非 HTTPS 基础地址，下载有重试次数限制。

如果已将 `docker-compose.images.yml` 和 `.env.images.example` 放在安装目录：

```bash
bash install-images.sh --local --prepare-only
# 等价的环境设置：
RAKAZO_DOWNLOAD_SKIP_EXISTING=1 bash install-images.sh --prepare-only
```

`--local` 只跳过已有文件，缺失文件仍会下载。`--prepare-only` 创建 `.env`，但不启动服务。

## 离线安装

先将两个必需文件放入安装目录，并在 Docker 主机预加载所有必需容器镜像，再运行：

```bash
bash install-images.sh --offline
```

即使已有 `.env`，缺少任意必需文件也会在调用 Compose 前失败。
此模式不下载文件、不需要 curl、不拉取镜像；Compose 支持时，启动会使用 `--pull never`。
旧版 Compose 不支持该参数时会显示警告。

离线安装计算机出站限制时，还要复制 `restrict-computer-egress.sh`。
没有这个可选脚本时，安装器会记录开放出站并告警，不会尝试下载。
显式配置的 `SANDBOX_COMPUTER_EGRESS` 不会被覆盖。主机要求见[计算机出站限制（英文）](../self-host-docker-computers.md#restricted-computer-egress)。

## 容器镜像

完成准备后，在 `.env` 中配置自己的镜像仓库：

```env
RAKAZO_IMAGE=registry.example.com/mirror/rakazo/app
RAKAZO_IMAGE_TAG=edge
RAKAZO_COMPUTER_IMAGE=registry.example.com/mirror/rakazo/computer
RAKAZO_COMPUTER_IMAGE_TAG=edge
POSTGRES_IMAGE=registry.example.com/library/postgres@sha256:<trusted-postgres-digest>
BUSYBOX_IMAGE=registry.example.com/library/busybox@sha256:<trusted-busybox-digest>
```

所有示例地址和摘要均须替换。应用和计算机镜像应使用同一发布版本；arm64 主机需要包含该架构的标签。
配置定义见 [docker-compose.images.yml](../../infra/compose/docker-compose.images.yml)。

Docker Hub 也可通过 Docker 守护进程的 `registry-mirrors` 配置镜像源；将其合并到已有 JSON 配置后重启 Docker：

```json
{
  "registry-mirrors": ["https://mirror.example.com"]
}
```

Docker Hub 的镜像设置不会替代 GHCR 应用与计算机镜像的覆盖配置。

## 验证镜像摘要后启动

镜像源仅是传输渠道，不能作为信任来源。从可信上游或另一台可信机器取得预期的 `postgres:16` 和 `busybox:1` 摘要，
将摘要固定在 `.env` 中。先运行准备命令，再拉取、校验，最后禁止重新拉取并启动。

下面的直接 Compose 启动不会执行安装器的计算机出站配置。开始前，在使用 iptables 防火墙后端的
Linux Docker Engine 主机上，将可信来源的 `restrict-computer-egress.sh` 复制到安装目录，
执行 `sudo bash ./restrict-computer-egress.sh`，先安装规则。

成功后，在 `.env` 中设置 `SANDBOX_COMPUTER_EGRESS=restricted`，并确认当前终端没有用不同值覆盖它。
这会让监督服务在无法验证防火墙规则时拒绝启动计算机，而不是降级为开放出站。
Docker Desktop、rootless Docker 和 nftables 后端不支持这套规则；需要这些隔离保证时，应改用支持的主机。
若明确选择 `SANDBOX_COMPUTER_EGRESS=open`，机器人计算机将能访问宿主机、局域网和云元数据。
不要把默认的 `auto` 当成隔离保证；缺少规则时它可能使用开放出站。
旧版 Docker 或自定义 DNS 的额外配置见[计算机出站限制（英文）](../self-host-docker-computers.md#restricted-computer-egress)。

下面在同一个 Bash 会话运行；先将占位值替换为可信摘要：

```bash
(
set -euo pipefail

export POSTGRES_IMAGE='registry.example.com/library/postgres@sha256:<trusted-postgres-digest>'
export BUSYBOX_IMAGE='registry.example.com/library/busybox@sha256:<trusted-busybox-digest>'

docker compose --env-file .env -f docker-compose.images.yml pull

for image_ref in "$POSTGRES_IMAGE" "$BUSYBOX_IMAGE"; do
  expected_digest="${image_ref##*@}"
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_ref" |
    awk -F@ -v expected="$expected_digest" '$2 == expected { found=1 } END { exit !found }' || {
      echo "digest verification failed for $image_ref" >&2
      exit 1
    }
done

docker compose up --help | grep -- '--pull' >/dev/null || {
  echo 'Docker Compose with up --pull is required for verified no-repull startup.' >&2
  exit 1
}

docker compose --env-file .env -f docker-compose.images.yml up -d --pull never
)
```

拉取、检查失败或摘要不匹配时会在启动前退出。上面的导出变量只对本次会话生效；
后续重启也要使用同样的固定摘要，因此应保存在安装目录的 `.env` 中，不要换回可移动标签。
启动后按[安装提示](../../SETUP_PROMPT.md)检查健康状态。

下载恢复后，继续[自托管安装](./self-host.md#已发布镜像无需检出源码)。
完全无法连接外部提供商时，使用本地 Docker 计算机和自己运行的[模型端点](./self-host-models.md)。
