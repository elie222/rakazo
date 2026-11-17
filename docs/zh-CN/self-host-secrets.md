# 自托管密钥清单

[English](../self-host-secrets.md) | 简体中文

已发布镜像和 Compose 部署所需及可选的凭据。

**不要提交 `.env`，不要把密钥值粘贴到 issue/PR，也不要在没有明确备份和操作者同意的情况下覆盖现有 `.env`。**

## 已发布镜像：安装器会填写什么

运行 `bash install-images.sh`（且不存在 `.env`）时，脚本会复制 `.env.images.example`，并用 `openssl` 填充空密钥：

| 变量                       | 安装器生成值           | 作用                                                 |
| -------------------------- | ---------------------- | ---------------------------------------------------- |
| `POSTGRES_PASSWORD`        | `openssl rand -hex 16` | Compose 内 Postgres 所有者密码（迁移使用）           |
| `POSTGRES_APP_PASSWORD`    | `openssl rand -hex 16` | 应用 `rakazo_app` 登录的密码，行级安全应用在该登录上 |
| `BETTER_AUTH_SECRET`       | `openssl rand -hex 32` | 登录和会话签名                                       |
| `ENCRYPTION_KEY`           | `openssl rand -hex 32` | 加密静态存储的凭据                                   |
| `SCREEN_PROXY_SECRET`      | `openssl rand -hex 32` | 签名短期的 `/novnc/*` 屏幕能力                       |
| `SANDBOX_SUPERVISOR_TOKEN` | `openssl rand -hex 32` | API 与沙箱监督服务之间的认证                         |
| `RAKAZO_UPDATER_TOKEN`     | `openssl rand -hex 32` | 专用更新器凭据；启用更新器 profile 前不会使用        |

再次运行会**保留**现有 `.env`（不会轮换密钥）；只在旧 `.env` 缺少 `POSTGRES_APP_PASSWORD` 时追加。空的必需变量仍会在 Compose 校验时立即失败（`${VAR:?Set … in .env}`）。

手动生成（与安装器使用的格式相同）：

```bash
openssl rand -hex 16   # POSTGRES_PASSWORD、POSTGRES_APP_PASSWORD
openssl rand -hex 32   # BETTER_AUTH_SECRET、ENCRYPTION_KEY、SCREEN_PROXY_SECRET、SANDBOX_SUPERVISOR_TOKEN
```

源码检出版本的 `.env.example` 也要求 `POSTGRES_PASSWORD` 和 `POSTGRES_APP_PASSWORD`（同样是 `openssl rand -hex 16` 格式），用于 `infra/compose/docker-compose.yml`。使用可选 `docker-compose.postgres-host.yml` 叠加层时，请把它们放入宿主机侧的 `DATABASE_MIGRATION_URL` 和 `DATABASE_URL`。密码必须可安全放入 URI：Compose 会像镜像栈一样把它插值进 `DATABASE_URL`。`openssl rand` 生成的十六进制是安全的；`@ : / ? # %` 等字符不安全。

已有的源码检出版本 `pgdata` 卷会保留首次初始化时的用户、密码和数据库（常见为旧的硬编码 `rakazo` / `rakazo`）。请把这些值保留在 `.env` 中，或用 `ALTER ROLE` / 重命名就地修改。只有在已有备份（或数据可丢弃）之后才应重建卷；`docker compose down -v` 会删除所有 Postgres 状态。

源码检出版本的 `.env.example` 注释要求 64 位十六进制的 `ENCRYPTION_KEY`；已发布镜像安装器通过 `openssl rand -hex 32` 生成 32 字节（64 个十六进制字符）。无论采用哪种方式，都请使用足够长的独立随机值。不要在多个变量之间复用同一个字符串。

## 独立性规则

以下必须是**相互独立**的随机值（不要把同一个密钥复制到多个变量）：

- `BETTER_AUTH_SECRET`
- `ENCRYPTION_KEY`
- `SCREEN_PROXY_SECRET`
- `SANDBOX_SUPERVISOR_TOKEN`
- `RAKAZO_UPDATER_TOKEN`（仅在启用更新器时；至少 32 字符，且不同于上面四个）

凭据已经存储后再轮换 `ENCRYPTION_KEY`，旧密文会变得不可读。除非有意清除加密数据，请为现有部署保留原始密钥。

`ENCRYPTION_KEY` 也会派生聊天、记忆和文件加密的默认主密钥，因此更换它还会让这些内容不可读。要让内容迁移出去，请设置 `ENCRYPTION_MASTER_KEYS` 并运行[内容加密](../content-encryption.md)中的轮换流程；该流程会重新包装 Space 密钥，不会让内容失效。之后保持 `ENCRYPTION_KEY` 不变：已存凭据仍依赖它。

设置 `MASTER_KEY_PROVIDER=aws-kms` 后，这些密钥和其他 API、worker 密钥可以由密钥管理器包装后保存在 `.env`，而不是明文保存（见[包装配置](../content-encryption.md#wrapped-settings)）。

## 可选密钥（未使用时留空）

来自 `.env.images.example`（镜像安装器）。未使用时留空：

| 变量                                                           | 需要的场景                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`                                           | 部署级 OpenRouter 模型                                                    |
| `TYPESAFE_API_KEY`                                             | 可选 TypeSafe Jev Auto Review 校验器（`RAKAZO_AUTO_REVIEW_PROVIDER=jev`） |
| `COMPOSIO_API_KEY`                                             | Composio 托管目录                                                         |
| `E2B_API_KEY` / `DAYTONA_API_KEY` / `BOAT_API_KEY`             | `SANDBOX_PROVIDER` 不是 `docker` 时的远程计算机                           |
| `EMAIL_PROVIDER` / `EMAIL_API_KEY` / `SMTP_URL` / `EMAIL_FROM` | 可选账号邮件，通过 Resend API 或 SMTP                                     |
| `BOT_EMAIL_SMTP_URL`                                           | 机器人发件使用的独立 TLS SMTP 连接；见 bot email                          |
| `EXPO_ACCESS_TOKEN`                                            | Expo 项目启用增强推送安全时的移动端推送                                   |
| 消息令牌（Slack、Telegram 等）                                 | 仅启用对应平台时                                                          |

可选的 `APNS_VOIP_KEY_ID`、`APNS_VOIP_TEAM_ID` 和 `APNS_VOIP_PRIVATE_KEY` 用于 [iOS VoIP 来电](../self-host-clients.md#mobile-incoming-calls)。`.p8` 内容应保存在密钥管理器中。

最小化已发布镜像启动时，可选密钥为空是正常的。Pipedream Connect 密钥只出现在源码/Compose 的 `.env.example`，不在镜像示例中。

## 操作者流程

```bash
bash install-images.sh --prepare-only   # 创建 .env 并填充空值
# 调试时只检查变量名；不要记录值
bash install-images.sh                  # 拉取并启动；保留 .env
curl -fsS http://127.0.0.1:3100/internal/health
```

如果 `/internal/health` 中的 `sandbox` 是 `"none"`，或监督服务一直不健康，请检查 Docker 计算机路径下 `SANDBOX_SUPERVISOR_TOKEN` 是否已设置且非空。缺少该令牌是安装失败，不是可以之后再补的可选项。

## 不重新打印密钥的恢复

- 忘记界面密码：如果配置了 SMTP，使用邮件恢复；否则操作者需要通过带外方式（数据库）恢复身份。不要随意在在线部署上轮换 `BETTER_AUTH_SECRET`。
- 丢失 `.env`：只能从备份恢复。如果 Postgres 卷仍在，重新生成随机密钥会导致密码和加密数据不同步。
- 迁移主机：把 `.env` 和卷一起移动；传输途中把 `.env` 当作密钥材料。

## 相关文档

- [自托管](./self-host.md)
- [配置](./self-host-configuration.md)
- [存储与加密](../self-host-storage.md)

## 可选凭据存储

存储凭据可以使用自托管 Infisical，短期密钥仍加密保存在 Postgres 中。见[Infisical 安装、迁移与回滚](../infisical-secrets.md)。
