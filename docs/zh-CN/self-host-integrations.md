# 工具与集成

[English](../self-host-integrations.md) | 简体中文

配置机器人可以访问模型之外的服务：网页搜索、记忆、MCP 服务器、应用、消息平台、云端编码智能体和支付。

## 网页搜索与网页读取

内置 `web_search` 和 `web_fetch` 默认使用无密钥 HTTP 搜索（DuckDuckGo HTML）和本地 Readability 提取。要选择 [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)，在 `.env` 中设置 `WEB_PROVIDER=parallel` 并重启 API 和 worker。相同的机器人工具会通过 HTTPS MCP 访问 `https://search.parallel.ai/mcp`，返回搜索摘录和提取后的页面 Markdown。无账号或 API 密钥时使用 Fast mode。

该选项会把搜索查询和请求的页面 URL 发送给 Parallel，由其服务器抓取页面。会话统计使用以 `ENCRYPTION_KEY`（API 和 worker 共享）为密钥的内部 ID HMAC；密钥不同的部署会发送不同的会话 ID。轮换该密钥会重置会话 ID；仅开发环境使用的加密密钥回退同样适用于这里。匿名访问有服务限制；限流和提供商错误会返回给机器人，不会切换提供商。按机器人禁用的网页工具保持禁用。设置 `WEB_PROVIDER=keyless-http` 或删除该配置即可回到默认。

要改用 [Keenable](https://docs.keenable.ai)，设置 `WEB_PROVIDER=keenable` 并重启 API 和 worker。相同工具会通过 HTTPS MCP 访问 `https://api.keenable.ai/mcp`，无需账号或 API 密钥，返回搜索摘要和页面 Markdown。该选项会把查询和页面 URL 发送给 Keenable，由其服务器抓取。匿名访问按 IP 限流；在 API 和 worker 上设置 `KEENABLE_API_KEY` 可以发送密钥并解除限制。错误处理、按机器人禁用工具和恢复默认的方式与 Parallel 相同。

## 自托管记忆

Supermemory、Honcho 和 Hindsight 可以运行在你自己的网络中。在 **Settings → Memory** 打开 **Advanced**，选择 **Self-hosted** 并输入实例 base URL。操作者必须设置 `MCP_ALLOW_PRIVATE_ENDPOINT=true`；之后工作区拥有者可以保存本地端点。它必须是回环地址，或解析到私有地址（Compose 服务名、RFC1918 或 unique-local 地址，或 Railway 私网等 `.internal` 名称）；Rakazo 会为每次请求固定解析出的地址。Space 成员使用已保存的连接，但看不到密钥。

使用 [Honcho](https://github.com/plastic-labs/honcho) 时，在 Honcho 服务器启用 `AUTH_USE_AUTH`，并用 `scripts/generate_jwt.py --admin` 生成的管理员 JWT 作为密钥，让每个 Space 拥有独立 workspace。如果输入的是某个 workspace，也可以使用 workspace 范围 JWT。Honcho 需要自己的带 pgvector 的 PostgreSQL、LLM 提供商和 embedding 提供商；首次启动前设置 `EMBEDDING_VECTOR_DIMENSIONS`。Rakazo 只把显式保存的事实存入 Honcho；会话摘要保留在 Rakazo。Honcho v3.2 及以上支持机器人遗忘已保存事实。

使用 [Hindsight](https://github.com/vectorize-io/hindsight) 1.0 及以上时，如果服务器没有认证，密钥可选。Hindsight 需要自己的 LLM 提供商来提取事实。Rakazo 为每个机器人创建一个 bank；Shared 范围则为每个 Space 创建一个。Bank 名称使用保留的 `rakazo-` 前缀和固定长度标识符哈希，避免旧标识符冲突。Rakazo 不配置 bank，因此如需提取任务请在 Hindsight 中设置。Rakazo 会发送每个完成的回合（除非关闭 **Learn from conversations**）和机器人保存的事实；**Recall from banks** 下的 bank 只读。该列表中的 bank 必须在同一个 Hindsight 服务器或 Cloud 账号上；在自己机器上内嵌运行 Hindsight 的应用会把 bank 留在那里。所有以 `rakazo-` 开头的名称都保留，不能在那里列出，包括其他应用用该前缀创建的 bank。

## MCP 服务器

远程 MCP 服务器和已安装的 API / GraphQL 连接器默认使用公网 HTTPS。部署拥有者可以附加 localhost、同一局域网或 Docker 网络中的服务器。在 API 和 worker 上设置 `MCP_ALLOW_PRIVATE_ENDPOINT=true` 可为所有用户启用这些地址。云元数据地址始终被阻止。公开部署请保持该配置未设置。

使用 OAuth 的远程 MCP 服务器通常会在第一次 **Connect OAuth** 时把 Rakazo 注册到提供商。有些提供商只接受在其控制台创建的 client。对这类服务器，在添加时打开 **Advanced**，输入 client ID（以及机密 client 的 secret），并把那里显示的 **Redirect URI**（`<your web origin>/mcp/oauth/callback`）加入 client 的允许回调。client 与服务器的其他凭据一起加密保存，并在 **Disconnect** 后保留；切换到不同 client 会丢弃当前授权。首次使用时，client 会绑定到 MCP 服务器指向的授权服务器，之后 Rakazo 拒绝发送到其他位置。替换 client 会清除绑定。

Stdio MCP 服务器也可以使用 OAuth。它不能自行授权（MCP 规范要求从环境读取凭据），因此 Rakazo 替它运行流程。只有在 API 和 worker 设置 `MCP_STDIO_ENABLED=true`，且命令列入 `MCP_STDIO_ALLOWED_COMMANDS` 时才启用。stdio 服务器在 API 和 worker 内部运行，拥有它们的访问权限，因此只有管理员（`RAKAZO_ADMIN_EMAILS` 中的已验证账号）能在 **Settings** 或智能体导入中添加或编辑；没有管理员时无人可以添加。机器人永远不能添加 stdio 服务器。所有人仍可添加远程服务器；管理员添加的 stdio 服务器对可用范围内的所有人继续工作。添加服务器时输入 OAuth client、其 **Authorization server**（issuer，例如 `https://accounts.google.com`）和 **Scopes**，然后像远程服务器一样点击 **Connect OAuth**。有些提供商只在额外参数要求下签发 refresh token：Google 请把 **Authorization parameters** 设为 `access_type=offline&prompt=consent`。通过环境变量把授权传给进程：

- 值可以引用 `{{oauth.access_token}}`、`{{oauth.refresh_token}}`、`{{oauth.client_id}}`、`{{oauth.client_secret}}`、`{{oauth.expires_at}}`（epoch 毫秒）、`{{oauth.scope}}` 或 `{{oauth.token_type}}`，可以单独使用，也可以嵌入其他文本。
- 变量也可以是 **File**：其模板（通常是 JSON，使用相同引用）会在进程启动时写入私有临时目录，变量收到该文件路径。适合需要凭据或 token 文件路径的包。

Rakazo 会在传入的 access token 快过期前刷新授权并重启进程，长时间运行的进程不会拿着失效 token。只收到 refresh token 的进程自行刷新。进程停止时会删除临时文件。

以 `npx [-y] <package>[@version]`（或 `npx -p <package> <bin>`）启动的服务器不会每次启动都下载。Rakazo 会用 `npm install` 安装一次包到 `MCP_PACKAGES_DIR`（默认 `DATA_DIR/mcp-packages`，API 和 worker 共享），不运行安装脚本，然后直接运行其 bin；`npx` 仍必须在 `MCP_STDIO_ALLOWED_COMMANDS` 中。安装有自己的超时 `MCP_STDIO_INSTALL_TIMEOUT_MS`（默认 180000），与握手超时 `MCP_STDIO_STARTUP_TIMEOUT_MS`（默认 30000）分开。请固定版本，让每次启动运行同一份代码；服务器环境变量中可以设置 `NPM_CONFIG_REGISTRY` 等 npm 配置。其他任何 `npx` 形式（本地路径、git 和 tarball URL、未知 `npx` 标志）都会被拒绝。`npx` 是唯一支持的包启动器；其他包管理器和运行器（`npm`、`pnpm`、`yarn`、`bun`、`bunx`、`deno`、`uv`、`uvx`、`pipx` 等）即使加入允许列表也会被拒绝。要运行其他生态的服务器，请在主机上安装并允许其二进制。允许的解释器或 shell（`node`、`python`、`sh`）会执行参数中的任意代码，只有可接受时才应允许。每个服务器在 API 和 worker 中为每个用户各运行一个进程，由该用户的机器人共享，并在 `MCP_STDIO_IDLE_MS`（默认 900000，15 分钟）无使用后停止。服务器启动失败时，原因（包括凭据已脱敏的 stderr 末尾）会显示在 **Settings** 的服务器条目上，其机器人会被告知服务器不可用，而不是静默丢失工具。

工具发现对远程和 stdio MCP 服务器都最多保留 `MCP_MAX_TOOLS` 个工具（默认 250），最多读取 `MCP_MAX_PAGES` 页（默认 20）。在 `.env` 中设置正的安全整数可以修改，例如 `MCP_MAX_TOOLS=1000` 和 `MCP_MAX_PAGES=100`。未设置、为空或无效时使用默认值。达到任一上限或服务器没有下一页时停止发现，并仍受现有响应大小和超时限制约束。Docker 部署需要把两个设置放在 API 和 worker 上；修改后重建这些容器。

一次运行不会在一个服务器上长时间等待。每个服务器有 `MCP_DISCOVERY_TIMEOUT_MS`（默认 20000）列出工具，超时后继续运行；仍在安装的包会在后台完成，工具在后续回合出现。失败后，运行会在 30 秒内跳过该服务器，持续失败时翻倍到最多 5 分钟。成功的 **Test connection** 或发现，或修改服务器设置，会立即结束等待。

如果服务器在 **Settings** 中显示工具，但机器人从不使用，请运行[诊断报告](./self-host.md#报告问题)。其 **Assignment** 列会指出阻止该机器人使用工具的 Space 或拥有者不匹配。

## 应用与连接器

设置 `COMPOSIO_API_KEY` 后，插件使用 [Composio](https://composio.dev)。Pipedream 是另一个托管连接器提供商：设置 `PIPEDREAM_CLIENT_ID`、`PIPEDREAM_CLIENT_SECRET`、`PIPEDREAM_PROJECT_ID` 和 `PIPEDREAM_ENVIRONMENT`（`development` 或 `production`），放在 API 和 worker 上。

当 Outlook 登录没有请求对应的 `.Shared` 权限时，对共享邮箱的调用会被拒绝；Composio 默认 Outlook 配置创建的连接曾被观察到缺少该权限。要让机器人读取或代发共享邮箱，请在 Composio 控制台创建 Outlook auth config，列出默认权限加上需要的 `.Shared` 变体（`Mail.Read.Shared`、`Mail.ReadWrite.Shared`、`Mail.Send.Shared`），并让新的 Outlook 连接使用该配置。该用户的账号还需要在 Exchange 中拥有邮箱的 Full Access，租户管理员可能需要同意 `.Shared` 权限。新配置只影响新连接，因此修改前已连接的人必须断开并重新连接 Outlook。

`INTEGRATIONS_CATALOG_URL` 让 API 连接器搜索指向兼容 [integrations.sh](https://integrations.sh/) 的目录，例如你托管的镜像。填写 base URL；Rakazo 会追加 `api/search`。

## 消息应用

消息适配器是可选的。为你需要的平台配置凭据；用户在 **Settings → Messaging** 绑定自己的机器人。支持的私聊和群聊流程见[聊天应用](../messaging-apps.md)。Teams、WhatsApp、Feishu/Lark 和 Photon 仅支持私聊。Slack 频道使用工作区安装；Telegram 和 Sendblue iMessage 使用个人群聊绑定。

每个平台只有在 API 和 worker 上拥有完整凭据集合时才启用。Webhook 地址是 `/api/v1/messaging/webhook/<provider>`。

| 平台                        | 设置                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iMessage 和 SMS（Sendblue） | `SENDBLUE_API_KEY_ID`、`SENDBLUE_API_SECRET`、`SENDBLUE_SIGNING_SECRET`、`SENDBLUE_PHONE_NUMBER`                                                                           |
| WhatsApp Business Cloud     | `WHATSAPP_ACCESS_TOKEN`、`WHATSAPP_PHONE_NUMBER_ID`、`WHATSAPP_APP_SECRET`、`WHATSAPP_VERIFY_TOKEN`                                                                        |
| Telegram                    | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET_TOKEN`                                                                                                                      |
| iMessage（Photon）          | `PHOTON_PROJECT_ID`、`PHOTON_PROJECT_SECRET`；如用 webhook 而不是流，设置 `PHOTON_WEBHOOK_SECRET`；更多项目用 `PHOTON_PROJECT_ID_<NAME>` 和 `PHOTON_PROJECT_SECRET_<NAME>` |
| Feishu/Lark                 | `LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_VERIFICATION_TOKEN`；开启事件加密时用 `LARK_ENCRYPT_KEY`；`LARK_DOMAIN`（默认 `feishu`，或 `lark`）                                |
| Microsoft Teams             | `TEAMS_APP_ID`、`TEAMS_APP_PASSWORD`、`TEAMS_APP_TENANT_ID`（单租户，仅私聊）                                                                                              |
| Slack                       | 见下文                                                                                                                                                                     |

### WhatsApp Business Cloud

使用运营者拥有的商业号码和直连适配器。注册、令牌权限、webhook 设置、当前地区 AI 限制和服务窗口限制见 [WhatsApp 上线 runbook](../hosted-whatsapp-launch.md)。仅配置凭据不代表满足使用资格。未实现主动模板提醒。

### Telegram

Telegram 在 `X-Telegram-Bot-Api-Secret-Token` 中发送 webhook 密钥。接收请求的 API 使用自动传输选择，未注册 webhook 时可以轮询；worker 永远不轮询。启动多个 API 实例前，请先注册托管 webhook。绑定目的地来自已认证的机器人身份，绝不是配置文件中的用户名。运营者注册和验收步骤见[托管 Telegram runbook](../hosted-telegram.md)。名为 `<NAME>`（字母和数字）的额外机器人使用提供商 `telegram-<name>` 和 webhook `/api/v1/messaging/webhook/telegram-<name>`；见[名称由你决定的配置](./self-host-configuration.md#名称由你决定的配置)。Telegram 群聊与 iMessage 一样使用个人群聊绑定：每个绑定成员批准自己的机器人；按房间监听设置只属于 Slack team conversation。请在 BotFather 中运行 `/setprivacy` 并选择 **Disable**（或把机器人设为群管理员），否则它只能收到提及自己的群消息。广播频道帖子不会启动运行。多个机器人可以并存，允许一个人通过不同机器人绑定不同的 Rakazo bot。

### 通过 Photon 使用 iMessage

该连接使用 Stable Spectrum API，而不是 Photon 2.0 Beta 凭据。适配器限制和运营者检查见[托管 iMessage/SMS runbook](../hosted-imessage-sms.md)。

Photon 通过 API 的出站流接收消息，因此不需要公开 URL。如要改用 webhook，设置 `PHOTON_WEBHOOK_SECRET`。每个额外项目使用 `PHOTON_PROJECT_ID_<NAME>` 和 `PHOTON_PROJECT_SECRET_<NAME>`（webhook 再加 `PHOTON_WEBHOOK_SECRET_<NAME>`），显示为 `photon-<name>`。共享线路上，必须由对方先发消息。不支持群聊。

### Feishu/Lark

创建带 Bot 能力的自建应用，并订阅 `im.message.receive_v1`。把事件订阅指向 `/api/v1/messaging/webhook/lark`。使用 webhook/HTTP 投递，而不是长连接。Lark 设置 `LARK_DOMAIN=lark`，Feishu 保留默认 `feishu`。开启事件加密时设置 `LARK_ENCRYPT_KEY`。适配器和 SDK 只在配置后加载。

### 绑定与注册

人们在 **Messaging** 设置中把聊天应用绑定到账号。设置 `MESSAGING_OPEN_SIGNUP=true` 时，未知发件人会获得只聊天的账号，其运行使用部署模型。

在房间中，机器人用自己的模型决定是否回应环境消息。如果该判断要使用单独模型，请同时设置 `TEAM_CHAT_JUDGE_PROVIDER` 和 `TEAM_CHAT_JUDGE_MODEL`。

### Microsoft Teams

本指南覆盖拥有机器人注册的 Microsoft 租户内安装。此配置尚未验证跨公司分发。

1. 在 Microsoft Entra ID 注册应用并创建 client secret。用该应用的 **Single Tenant** 身份创建 Azure Bot，然后启用其 Microsoft Teams channel。
2. 在 API 和 worker 上设置 `TEAMS_APP_ID`、`TEAMS_APP_PASSWORD`（client secret **值**）和 `TEAMS_APP_TENANT_ID`。租户 ID 是拥有机器人注册的租户。
3. 把机器人 messaging endpoint 设为 `https://your-domain.example/api/v1/messaging/webhook/teams`，必须可通过公网 HTTPS 访问。Microsoft JWT 校验保持开启。
4. 在 Teams Developer Portal 创建 Teams 应用，使用已有机器人 app ID 和 `personal` scope。填写图标、网站、隐私政策和服务条款，验证并下载应用包。
5. 请 Microsoft 365 管理员把包上传到组织的 Teams app catalog，并允许目标用户使用。在 Teams 中安装 catalog 应用并打开其私聊。
6. 在 Rakazo 的 **Settings → Messaging** 下选择机器人，选择 `teams`，并在 10 分钟内把代码私聊发给 Teams 应用。

一个服务器注册服务多个个人绑定用户；它不会把部署绑定到一个 Rakazo 账号、Space 或机器人。回复使用每个用户的已绑定会话，服务器重启后也一样。不支持 Teams 频道、群聊和按用户地址发起新私聊。不需要 Microsoft Graph 历史权限。

安装时的 **Permissions needed**，请在 Teams 管理中心检查应用对相关用户是否可用。Developer Portal 预览或个人包上传，还要检查实际分配给该用户的策略中的 **Teams apps → Setup policies → Upload custom apps**。单独的测试用户策略可以启用预览，而不改变组织默认值。变更可能需要几小时。管理员已发布到组织 catalog 时，请安装组织 catalog 版本；Developer Portal 预览是另一条上传路径。

参见 Microsoft 的[自定义应用安装指南](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload)和 [app setup policies](https://learn.microsoft.com/en-us/microsoftteams/teams-app-setup-policies)。在认为安装完成前，请在注册租户中绑定一个用户并验证消息/回复往返。再用绑定到不同 Rakazo 机器人的第二个用户重复测试，确认个人路由。包验证或安装成功本身不能证明消息投递可用。

### Slack

Slack 工作区安装需要在 API 和 worker 上设置 `SLACK_CLIENT_ID`、`SLACK_CLIENT_SECRET` 和 `SLACK_SIGNING_SECRET`。使用公开 API origin（`API_URL`）注册 OAuth 回调 `https://app.example.com/api/v1/messaging/install/slack/callback`。在 Slack 应用的 Manage Distribution 设置中启用分发，让其他工作区可以安装。启用 Slack Events API 投递到 `https://app.example.com/api/v1/messaging/webhook/slack`，订阅 `app_mention`、`message.im`、`message.channels`、`message.groups`、`message.mpim` 和 `app_uninstalled`。启用应用的 Messages tab。安装流程会请求它使用的消息/历史、频道/用户查询、文件读写和 reaction 写入 scope；修改 scope 后需要重新安装 Slack 应用。不使用 Socket Mode。

在 Messaging 设置中选择 Slack 行的 **Connect**。工作区以默认 Space 中的第一个机器人应答，无论当前打开哪个 Space。每个 Slack 工作区属于一个 Rakazo Space 和一个安装拥有者；从另一个 Space 安装会被拒绝。要私聊该机器人，使用 **Link DMs** 并把代码私聊发给 Slack 应用。同一 Space 的队友可以用同样方式绑定自己的机器人。把 Slack 应用邀请进频道并提及它即可在频道中收到回复。机器人的外部会话提供 **Mentions only**、**Listen** 和房间指引。工作区设置和个人绑定在网页、桌面和移动端可用。移动端在系统浏览器中打开 Slack 授权；完成后返回应用。频道监听设置目前只在网页/桌面界面中。

令牌用配置的密钥存储加密。worker 为每个出站操作解析安装，包括排队回复；断开安装会停止后续投递并解绑其个人私聊。Slack 签名的 `app_uninstalled` 事件也会移除安装。断开连接删除 Rakazo 本地凭据；要在 Slack 侧撤销安装，请在 Slack 中移除应用。安装拥有者必须保留 Space 成员身份和活跃机器人。工作区安装需要没有 Slack token rotation 的 workspace-level bot token；Enterprise Grid 组织级安装和轮换 token 会被明确拒绝。

旧的 `SLACK_BOT_TOKEN` 加 `SLACK_SIGNING_SECRET` 配置仍支持单个工作区。配置 OAuth 模式时优先使用；使用工作区安装前，必须重新绑定旧的静态 Slack 身份/会话。`TEAM_CHAT_BOT_ID` 只为静态配置选择频道机器人，不会覆盖工作区安装或个人私聊。从 Integrations 界面授权的 Slack 工具与这个消息面是独立连接。

## 云端编码智能体

云端智能体把仓库任务委托给托管编码智能体，并在机器人聊天中跟踪结果。它们独立于机器人计算机和回合内子智能体。网页、Electron 和移动端显示相同状态和 PR 链接。

默认为 `CLOUD_AGENT_PROVIDER=none`。核心工作流不需要 Cursor 或任何其他托管编码提供商。

### 启用 Cursor

在 API 和 worker 上配置相同值：

```dotenv
CLOUD_AGENT_PROVIDER=cursor
CLOUD_AGENT_SPACE_ID=example-space-id
CURSOR_API_KEY=replace-with-your-key
```

密钥和显式 Space ID 都是必需的。使用的凭据应允许该 Space 成员访问其连接的仓库。每个创建的智能体还会绑定发起用户；其他用户不能通过智能体 ID 查看、回复或取消它。部署密钥永远不会成为模型工具参数。

### 连接 T3 Code

T3 Code 在你控制的机器上运行智能体。每个用户连接自己的 T3 Code 环境；无论 `CLOUD_AGENT_PROVIDER` 是什么，它都不需要部署设置，并遵循 MCP 服务器通常的访问规则：分配给它的 Rakazo 智能体，以及它可用的 Space。这些 Rakazo 智能体启动的云端智能体会改在 T3 Code 上运行；已在部署提供商上运行的智能体仍可访问。

1. 在 T3 Code 中，从 **Use T3 Code in another app (MCP)** 复制地址，以 `/mcp` 结尾。
2. 在 Rakazo 的 **MCP servers** 中添加为远程服务器，点击 **Connect OAuth**。
3. 在打开的 T3 Code 页面，把访问级别设为 **Auto**（没有登录码时默认为 **Read only**）并批准。

Rakazo 通过编排工具和输入 schema、显式 operate 授权，以及匹配的 OAuth resource 与授权 origin 识别兼容连接，而不是显示名称。

**Read only** 下，服务器不会用于新智能体。**Supervised** 下，每个编辑文件的运行都会等待 T3 Code 中的批准，其卡片在此之前显示运行中。要修改级别，请断开并重新连接服务器；断开会把其运行中的智能体标记为过期。T3 Code 的批准有效期 30 天，不可续期。过期或撤销后，新智能体停止使用该服务器，运行中智能体的卡片标记为过期，服务器显示 **Reconnect OAuth**。移除、禁用或断开服务器，或让它在 Space 中不可用，也会同样结束其智能体。此时如果部署有提供商，新的云端智能体会改用部署提供商。

第 1 步的地址经过 T3 Connect，是公网 HTTPS。直接私有地址（例如 Tailscale）需要在 API 和 worker 上设置 `MCP_ALLOW_PRIVATE_ENDPOINT=true`。该设置是部署级的：会让每个用户的 MCP 服务器都能访问私有地址。

带仓库启动时，会在未归档且 Git remote 匹配的 T3 Code 项目中，从该项目当前 checkout 分支出一个新 worktree；没有匹配项目的仓库会被拒绝。不带仓库启动使用 scratch folder。智能体使用 T3 Code 默认模型；未设置时使用第一个可运行提供商的模型。不支持图片。Rakazo 只在智能体运行结束后发送 follow-up；它会排在 T3 Code 自身启动的回合之后。取消只停止智能体当前运行，或移除尚未开始的 follow-up。当智能体运行结束后另一个运行立即开始（例如 T3 Code 自行继续），卡片会跟踪那个运行。连接访问级别允许时，T3 Code 持有而不启动的 follow-up（如 worktree 设置停止或失败、提供商失败或在 T3 Code 中 **Stop** 后）会在约一分钟后把卡片标记为失败，并从 T3 Code 队列移除。缺少 Rakazo 所用工具的 T3 Code 版本会让卡片失败。

工具包括 `cloud_agent_launch`、`cloud_agent_status`、`cloud_agent_reply` 和 `cloud_agent_cancel`。三个变更操作都遵守现有操作审批规则和 auto-review 策略。与其他有后果的工具一样，空规则集和禁用 auto-review 默认允许执行。

Launch 接受 prompt、可选仓库、图片和 `openPr`。有意不支持原始环境变量：通过模型生成工具参数传递密钥会把它们保存在普通历史中。请直接在提供商处配置远程环境密钥。

### 恢复

数据库独立于聊天卡片保存所有权和待处理操作。worker 和 reconciler 会恢复队列失败和被中断的启动。Cursor 创建使用稳定 client agent ID，因此重试已接受的创建不会创建另一个远程智能体。T3 Code 启动同样使用稳定 request key，除非服务器在运行中被重新连接。

每个 follow-up 跟踪自己的远程运行。当 follow-up 响应丢失时，worker 会观察最新运行，而不是重发 prompt。在能区分新运行前，状态保持 pending，不会把旧运行误报为完成 follow-up。取消同样保持 pending，直到远程状态确认。如果请求结果长期未知，请在提供商网站上检查智能体。

清空聊天、删除或归档机器人，或移除拥有者的 Space 成员身份，会在下一次对账时取消待处理远程工作。清空聊天不会删除所有权，也不会重建被移除的卡片。终态通知会在持久记录中去重。

如果密钥或提供商变化，已存凭据绑定会失败关闭。轮换凭据、更改授权 Space 或禁用提供商前，请取消或完成活跃智能体。如果过早更改，请恢复原配置以对账这些智能体，或直接在提供商处停止它们。没有任何已有智能体会被静默路由到替换凭据。

### 离线验证

`CLOUD_AGENT_PROVIDER=emulator` 会在进程内 Cursor HTTP emulator 上运行真实 Cursor adapter，用于开发和 web E2E。它不跨进程持久化。

Emulator 无网络调用地模拟运行创建、未知运行状态、归档或过期智能体、移除智能体和运行、拒绝密钥以及限流。conformance suite 会针对它运行；`pnpm test:integration` 用 Cursor emulator 验证数据库生命周期：丢失响应、过期运行元数据、队列故障、所有权边界、清空聊天、worker 重启、重叠轮询和取消竞争。

## 支付

机器人可以用用户的钱包购买商品。每个用户连接自己的钱包；任何卡号或支付 token 出现之前，每次购买都要求用户在钱包提供商的应用或页面中批准。卡号、安全码和支付 token 直接进入商户，永远不会到达模型、聊天历史、工具结果或日志。

默认为 `PAYMENT_WALLET_PROVIDER=none`。核心工作流不需要钱包；未配置时用户看不到与支付相关的内容。

### 启用 Link

在 API 和 worker 上配置相同值：

```dotenv
PAYMENT_WALLET_PROVIDER=link
# 可选。默认使用 Link 的公开登录 client。
PAYMENT_WALLET_CLIENT_ID=
```

用户会在 Settings 中看到 Link 连接按钮。连接会打开 Link 登录页并要求确认。连接后，机器人获得 `request_purchase`、`purchase_status` 和 `paid_request`。每个请求写明金额和原因；用户在 Link 中批准或拒绝。购买在请求 Link 之前，也会计入用户的[支出限额](../approvals.md#spending-limit)。

Link 仅对位于美国和加拿大的用户可用。

未知或空值会回退到 `none`，不会在启动时失败。

### 购买如何支付

- **卡。** 批准后会签发一次性卡。机器人会在购买页面自己的 HTTPS origin 上输入卡号，可以是在页面中，也可以是已知支付提供商在该页面中的 frame。
- **Pay token。** 接受 Link pay token 的 Stripe checkout 会在页面快照中写明，并带有商户账号。机器人为该账号请求购买；批准后把 token 交给 checkout，页面随后显示用户保存的 Link 卡。Token 在批准后 30 分钟过期。
- **付费 HTTP 请求。** `paid_request` 发送 HTTPS 请求。如果服务器返回带 Stripe Machine Payments Protocol challenge 的 `402 Payment Required`，金额来自 challenge，用户批准后机器人重新发送请求，请求会携带支付。绝不支付其他支付方式。请求在发送前加密存储，不能携带凭据或 cookie，重定向会报告而不是跟随。支付 token 只使用一次；被拒绝的付费请求需要重新批准。

### 断开连接

在 Settings 中断开会撤销与提供商的连接。如果提供商先撤销（例如用户在 Link 中退出登录），购买工具会停止工作，直到用户重新连接。

### 离线钱包验证

`PAYMENT_WALLET_PROVIDER=emulator` 为开发和测试运行进程内钱包。登录立即完成；购买在下一次状态检查时批准，金额超过 1,000.00 会被拒绝。它填写测试卡 `4242 4242 4242 4242`，签发虚假 pay token，并用虚假 token 支付 402 响应中的 Stripe challenge。共享 conformance suite 针对它和由 fake Link API 与 fake paid API 支撑的 Link adapter 运行，无需网络。
