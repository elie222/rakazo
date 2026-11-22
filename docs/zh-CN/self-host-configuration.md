# 配置

[English](../self-host-configuration.md) | 简体中文

Rakazo 从环境变量读取配置。使用 Compose 时，这些变量通常保存在 Compose 文件旁边的 `.env` 中。

## 配置保存在哪里

每个服务在启动时读取自己的配置，因此修改后需要重启读取该配置的服务。源码检出版本的 `.env.example` 和已发布镜像版本的 `.env.images.example` 列出了常用配置，并带有简短说明。

不要提交 `.env`。也不要把 `COMPOSIO_API_KEY`、OpenRouter 密钥或提供商令牌放进 Git、日志或聊天。

## 名称由你决定的配置

Compose 文件会按名称把每个服务需要的配置传给 API 和 worker，而不是把整个 `.env` 传进去。因此，名称由你决定的配置（例如 `TELEGRAM_BOT_TOKEN_<NAME>` 或 `PHOTON_PROJECT_ID_<NAME>`）需要单独列出：在叠加于基础文件的 override 文件中，把该变量加到 `api` 和 `worker` 的 `environment` 下（启用更新器时也要加入 `RAKAZO_COMPOSE_FILE`），值留空，让 Compose 从 `.env` 填充。`install-images.sh` 会提示没有任何容器接收的 `.env` 配置。

```yaml
# docker-compose.override.yml
services:
  api:
    environment:
      TELEGRAM_BOT_TOKEN_SUPPORT:
      TELEGRAM_WEBHOOK_SECRET_TOKEN_SUPPORT:
  worker:
    environment:
      TELEGRAM_BOT_TOKEN_SUPPORT:
      TELEGRAM_WEBHOOK_SECRET_TOKEN_SUPPORT:
```

`install-images.sh` 会自动叠加旁边的 `docker-compose.override.yml`。在自己的命令中，请把 `-f docker-compose.override.yml` 放在基础文件之后。

## 核心配置

以下配置均为可选：

```env
RAKAZO_EXTRA_AUTH_ORIGINS=   # 额外允许登录和调用 API 的来源；见下文
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SCIM_BEARER_TOKEN=        # 允许身份提供商增删账号；见“登录与账号”
SANDBOX_PROVIDER=docker   # 也可为 none、e2b、novita、daytona、createos、boat。fake 仅用于 pnpm test
AGENT_RUNTIME=pi          # scripted 仅用于 pnpm test
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # 空闲 10 分钟后暂停或停止；0 表示禁用空闲休眠
# Docker 自托管时可将它设为 0：空闲计算机没有额外成本，可保持长时间运行的应用和会话。
# E2B、CreateOS 和 Boat 仍会应用自己的超时。
COMPUTER_MAX_ACTIVE_MS=7200000 # 按运行时长计费的提供商的运行上限；最小 60000；0 表示禁用
COMPUTER_MAX_ACTIVE_UNBILLED_MS=0 # 不按运行时长计费的提供商（Docker、Kubernetes、Incus）的运行上限；最小 60000；默认 0 表示禁用；需开启 SANDBOX_IDLE_MS
SANDBOX_COMMAND_TIMEOUT_MS=300000 # 5 分钟后停止 shell 命令
MAX_TOOL_CALLS_PER_TURN=  # 可选的 Pi 单轮工具调用熔断值；未设置或为 0 表示不限
RAKAZO_MESSAGE_USER_MAX_CHARS=500 # message_user 的长度上限；旁白仍为 500
E2B_API_KEY=              # SANDBOX_PROVIDER=e2b 时使用
NOVITA_API_KEY=           # SANDBOX_PROVIDER=novita 时使用；需先构建其模板
DAYTONA_API_KEY=          # SANDBOX_PROVIDER=daytona 时使用
CREATEOS_SANDBOX_API_KEY= # SANDBOX_PROVIDER=createos 时使用
BOAT_API_KEY=             # SANDBOX_PROVIDER=boat 时使用
```

`STUCK_WORK_NOTIFY_AFTER_MS`（默认 `14400000`，4 小时）决定排队中的运行多久后让 worker 发送“仍在等待”提醒。`STUCK_WORK_EXPIRE_AFTER_MS`（默认 `86400000`，24 小时）决定多久后由 worker 停止该运行、在会话中留下状态行，并释放机器人的计算机。两者的范围都是 `60000` 到 `2592000000`（30 天）毫秒；其他值会保留默认值。过期时间小于提醒时间时，会跳过提醒。无人处理的接管请求仍在 30 分钟后停止。超过 4 小时的排队运行会在活动列表中持续标记。机器人提出的问题会保持打开，直到有人回答；但如果其运行持有仅为自己申请的登录或验证码，该运行仍会在过期时停止。

`MODEL_STREAM_MAX_RETRIES`（0 到 5，默认 `1`）会在模型流中途失败时重试。更多重试可以让长回合在提供商短暂故障后继续。

模型超时以毫秒配置。无效或超出范围的值会保留默认值。多个机器人共享一个会排队请求的本地推理服务器时，延长超时可能有帮助。对于 `RAKAZO_LOCAL_MODELS` 服务器和应用中添加的兼容模型连接，这些设置是 Rakazo 施加的唯一限制；流被切断时，运行错误详情会说明原因，例如 `terminated (other side closed)`。内置提供商仍会在 5 分钟无数据后丢弃响应，中间的代理或负载均衡器也可能更早切断静默流。

- `MODEL_STREAM_TIMEOUT_MS`（默认 `120000`，范围 `1000`–`2147483647`）是重试同一个模型的时间预算，也控制 OpenAI Chat Completions、Responses、Codex、Anthropic Messages、Mistral 或 Azure OpenAI 等待响应头的时间。Google、Vertex AI、Bedrock 和部分路由模型等其他 API 使用各自客户端的超时。
- `MODEL_STREAM_IDLE_TIMEOUT_MS`（默认 `180000`，范围 `0`–`2147483647`）限制已开始的响应可以静默多久。设为 `0` 可关闭 Rakazo 的不活动看门狗。显式取消请求仍然可用。如果提供商和调用方都不终止请求，关闭该保护会让停滞请求无限等待。
- `MODEL_CONNECT_TIMEOUT_MS`（默认 `30000`，范围 `1000`–`300000`）限制连接应用中添加的 OpenAI 兼容模型或语音连接的时间。`RAKAZO_LOCAL_MODELS` 服务器和内置提供商保留 Node 自身的连接超时。

### 从第二个地址访问 Rakazo

只有 `WEB_ORIGIN`、`API_URL`、`BETTER_AUTH_URL` 和移动应用可以登录和调用 API。如果同一个部署还会通过其他地址访问，例如 Tailscale 名称或局域网 IP，浏览器或桌面应用会收到 `403 INVALID_ORIGIN`。把这些地址加入 `RAKAZO_EXTRA_AUTH_ORIGINS`，用逗号分隔：

```env
RAKAZO_EXTRA_AUTH_ORIGINS=https://rakazo.your-tailnet.ts.net,http://192.168.1.20:5173
```

每项必须是纯 origin（协议、主机、可选端口；不能有路径）。任何主机都可以使用 `https://`。`http://` 只允许回环地址、`.local` 和私网 IP（RFC 1918 以及 Tailscale 的 `100.64.0.0/10`）。其他值会被忽略并记录警告。只有明确列出的 origin 会被信任；默认没有额外 origin。`WEB_ORIGIN` 仍是链接、通行密钥和 OAuth 回调使用的地址。

## 功能开关

| 变量                   | 默认值      | 效果                                                                                                      |
| ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| `TICKET_BOARD_ENABLED` | `false`     | 为所有账号开启工单板。否则每个人在 **Settings → Labs** 中自行开启。需设置在 API 和 worker 上。            |
| `USER_DEVICES_ENABLED` | 开启        | `false` 阻止已登录的桌面应用允许机器人在用户自己的计算机上运行命令。需设置在 API 和 worker 上。           |
| `PI_SESSION_RECORDING` | 关闭        | `true` 会把智能体会话记录为 `DATA_DIR/pi-sessions` 下的 JSONL。文件未加密，不要在共享或多租户部署中使用。 |
| `PRIVACY_POLICY_URL`   | Rakazo 政策 | AI 数据共享提示中链接的隐私政策。设置在 API 上。                                                          |

## 聊天历史保留

Rakazo 会保留聊天历史，直到有人清空聊天或删除机器人。要自动删除，请在 API 和 worker 上把 `CHAT_HISTORY_RETENTION_DAYS` 设为整数天数：

```env
CHAT_HISTORY_RETENTION_DAYS=180
```

大约每小时会有一个实例删除早于该天数的信息和聊天事件，从最旧的开始，使每个聊天保留连续的近期历史。正在运行机器人任务、等待回答的问题或接管的聊天会等其完成；排在某个运行后面的消息同样会等待。旧消息的已保存摘要会随之删除。未设置或留空表示永久保留。其他不是 `1` 到 `36500` 之间整数（包含 `0`）的值会让 worker 以及自跑任务的 API（`WAKEUP_DRIVER=memory`）拒绝启动，这样输入错误不会导致历史被悄悄保留。应用中已经打开的聊天会继续显示已删除消息，直到重新加载。

该设置不会删除：运行记录（任务提示和错误）、机器人存储的文件和截图、机器人保存的记忆、回复引用的原消息摘录、复制到已连接聊天应用的消息，以及有独立保留策略的[审计日志](../self-host-audit-log.md#retention)。从应用中无法恢复已删除的历史；[备份](./self-host-backups.md)按自己的保留策略保存。

## 数据库角色

Rakazo 使用两个 Postgres 登录：

- 所有者（Compose 中为 `POSTGRES_USER`，Compose 之外为 `DATABASE_MIGRATION_URL`）运行迁移并拥有表。
- 应用登录（Compose 中为 `rakazo_app` 和 `POSTGRES_APP_PASSWORD`，或 `DATABASE_URL`）不是超级用户，不能绕过行级安全，不能创建对象，只能读写应用表。

`pnpm db:migrate`（容器内为预构建的 `pnpm --filter @rakazo/api db:deploy`，一次性 `migrate` 容器会在 API 启动前运行）以所有者身份应用迁移和任务队列 schema。只有该容器拿到所有者登录，因此 API 或 worker 中运行的代码找不到能绕过行级安全的登录。随后它会创建 `DATABASE_URL` 指定的应用登录或更新其密码，并授予 `rakazo_app` 角色。如果迁移运行的角色没有 `CREATEROLE`（部分托管 Postgres 如此），请自行创建登录并执行 `GRANT rakazo_app TO <login>`。

消息、事件、会话、记忆、工件、密钥、模型和语音凭据、技能、机器人、运行、任务、例程、连接、MCP 服务器、登录状态、计算机、看板和工单、消息身份和发件箱、外部会话、引导消息、用量、草稿项和审批规则都有行级安全。每个已登录请求只能看到自己 Space 的行，加上用户自己的账号级凭据。漏掉 Space 过滤条件的查询不会返回其他 Space 的行。代表某个运行、例程、计算机、技能、会话或云端智能体执行的后台任务使用该行的 Space 和用户身份，因此智能体工具有同样的兜底保护。安全事件只在系统作用域写入和读取。对账器、队列扫描、聊天投递和 webhook 在 `packages/db` 的命名系统作用域（`runAsSystem`）中运行。该作用域还会发送一个从应用登录密码派生的键，`pnpm db:migrate` 会注册它，因此某个 Space 中的 SQL 无法把自己切换到系统作用域。如果 `DATABASE_URL` 中的应用登录没有密码，就没有该键，`pnpm db:migrate` 会警告。任务队列表（`graphile_worker`）只保存任务元数据，不含 Space 内容：graphile-worker 为它们启用行级安全，`pnpm db:migrate` 添加策略，让应用登录可以访问所有行。

只设置 `DATABASE_URL` 时，迁移和应用共享同一个登录。一切仍可工作，但 `pnpm db:migrate`、API 和 worker 会警告行级安全未被强制执行。要修复，请把 `DATABASE_MIGRATION_URL` 设为所有者，并把 `DATABASE_URL` 设为新的应用登录。

请以所有者身份运行 `pg_dump`。应用登录只能导出它被允许看到的行。

## 数据库连接

API 维护 4 个 Postgres 连接，worker 维护 8 个。`DB_POOL_MAX` 会同时设置两者，因此应按 worker 的需求计算：Graphile Worker 至少需要 6 个连接，worker 还会持有 3 个监听连接和 1 个领导选举连接。

`REALTIME_DATABASE_URL` 可以让承载实时更新的长连接 `LISTEN` 使用与 `DATABASE_URL` 不同的地址，例如 `DATABASE_URL` 经过事务池时使用直连。默认等于 `DATABASE_URL`。

`GRAPHILE_WORKER_CONCURRENCY`（默认 `4`）限制旧交互式任务队列在滚动升级期间的并发投递。新的智能体运行直接从 Postgres 派发，不占用这些槽位。

`RUN_DRAIN_ENABLED=true` 允许正在停止的 worker 先完成当前回合，最多等待五分钟，再交还任务；否则它会立即交还，下一个 worker 会重复进行中的模型调用。`docker-compose.prod.yml` 已开启它。只有在停止的 worker 能独占运行超过五分钟的环境（如 Compose 的 `stop_grace_period`）中才应开启；过早杀掉的 worker 会留下一个回合中途的运行，等待租约过期。

## API 和 worker 内存

聊天运行在收到消息的 API 容器中执行，例程和其他后台运行在 worker 中执行，因此两边都会持有活跃智能体回合。生产 Compose 文件用 `RAKAZO_API_MEMORY_LIMIT` 和 `RAKAZO_WORKER_MEMORY_LIMIT` 限制它们（支持 `2g`、`3072m` 等 Compose 格式，默认各为 `2g`）。较大的主机可以提高上限。部署时会短暂同时运行新旧容器，请为两边都留出内存。

## 更多 API 和 worker 容器

每个 API 和 worker 容器大约使用一个 CPU 核。主机核数更多时，`RAKAZO_API_REPLICAS` 和 `RAKAZO_WORKER_REPLICAS`（默认各 `1`）可以运行多个副本；它们通过 Postgres 分担工作，Caddy 会把请求分发到多个 API 容器。部署脚本下次运行时会应用新的副本数，先启动新数量的容器，再停止旧容器，因此部署期间请为两倍数量留出内存。API 容器多于一个时，请为 Telegram 机器人和 iMessage 项目设置 webhook secret；否则每个 API 都会轮询同一批消息。

部署还会短暂需要两倍数据库连接。每个 API 和 worker 容器最多持有 `DB_POOL_MAX` 个连接，再加上几个实时更新连接；Postgres 默认总共允许 100 个。当两倍容器总数接近该值时，请以所有者（`POSTGRES_USER`）运行 `ALTER SYSTEM SET max_connections = 200;` 并重启 Postgres。否则部署会因 "too many clients" 让部分请求失败。

## Postgres 内存

生产 Compose 文件按 8 GB 主机调整 Postgres：`POSTGRES_MEMORY_LIMIT` 限制容器（默认 `2560m`），`POSTGRES_SHARED_BUFFERS` 设置缓存（默认 `1GB`，计入上限），`POSTGRES_EFFECTIVE_CACHE_SIZE` 告诉规划器可保持缓存的数据量（默认 `2GB`）。较小的主机应连同 API 和 worker 上限一起调低。修改后会重启 Postgres。

## 监听地址

API 监听 `API_HOST`（默认 `127.0.0.1`）和 `API_PORT`（默认 `3100`）。除非容器或可信反向代理必须访问，否则保持回环地址；Compose 文件已为你设置。已发布镜像栈把网页应用发布到 `127.0.0.1:5173`，API 发布到 `127.0.0.1:3100`；如需其他宿主端口，设置 `RAKAZO_WEB_PORT` 或 `RAKAZO_API_PORT`。局域网访问请按[同一网络连接手机](../self-host-clients.md#connecting-a-phone-on-the-same-network)设置 `RAKAZO_WEB_BIND`。

## 出站代理

要让 API 和 worker 的出站流量经过公司代理，请在 `.env` 中设置 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`（大小写均可）。把栈内服务名加入 `NO_PROXY`，让内部流量跳过代理：

```env
HTTPS_PROXY=http://proxy.example.com:3128
NO_PROXY=localhost,127.0.0.1,postgres,supervisor,api,worker,web
```

安装器和镜像的镜像源见[受限网络](./self-host-restricted-network.md)。
