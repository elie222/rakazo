# 登录与账号

[English](../self-host-accounts.md) | 简体中文

决定谁能创建账号、人们如何登录：允许名单、邮箱验证、SSO、通行密钥和密码规则。

## 谁能注册

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
```

`SIGNUPS_ENABLED` 和 `SIGNUP_ALLOWLIST` 每次启动时都来自操作者环境。空允许名单会清除旧的已存名单；注册顺序不会授予任何特权。

服务器配置属于操作者环境。应用账号不能修改注册策略、服务器集成凭据或部署更新，也不能读取部署安全日志。

这里没有应用管理员角色、首个用户特权或 `ADMINS` 列表。工作区拥有者只能管理自己的工作区。

`RAKAZO_ADMIN_EMAILS` 用逗号分隔指定账号，用于审核插件提交、添加 stdio MCP 服务器（见[工具与集成](./self-host-integrations.md)），以及在出售模型额度的部署上通过 `/admin/access` 发放免费额度。邮箱验证后账号才生效。该列表不授予其他权限。

免费额度指定一个邮箱，最多提供 $1,000 模型额度、最多 12 个月的自带密钥免费使用，或两者兼有。拥有该已验证邮箱对应组织的用户，无论在发放前后注册，都会在下次打开应用时收到额度。额度在领取前可以撤销。

## 邮箱验证与登录验证码

当注册允许名单非空且已配置 SMTP 时，用户（包括已有账号）必须验证邮箱才能登录。没有允许名单时，验证不会阻塞：密码注册会立即登录，并收到一个只用于标记邮箱已验证的链接。

SMTP 还启用六位邮箱登录验证码。验证码 10 分钟有效，最多尝试 3 次。验证码可以创建账号，因此遵守与密码注册相同的注册和允许名单规则。用验证码登录一个未验证的已有账号，会删除该账号的密码、SSO 绑定和会话，因为没有任何证据表明它们属于邮箱拥有者。这也防止先抢注他人邮箱的人继续保有访问权。密码重置同样证明邮箱所有权，因此重置未验证账号的密码也会删除其 SSO 绑定、通行密钥和配对设备。

允许名单注册要求邮箱验证和邮件投递，包括第一个账号。没有邮件投递时，请使用下文的服务端账号引导；公开注册永远不会标记邮箱已验证或授予服务器权限。

## 无邮件安装

没有邮件服务的安装，先在 `.env` 中设置 `SIGNUPS_ENABLED=false` 并启动服务。然后私下创建预期账号（密码只保留在 shell 环境中）：

```bash
read -r -p "Account email: " OWNER_EMAIL
read -r -s -p "Account password (at least 16 characters): " OWNER_PASSWORD
export OWNER_EMAIL OWNER_PASSWORD
docker compose --env-file .env -f docker-compose.images.yml exec -e OWNER_EMAIL -e OWNER_PASSWORD api node dist/cli/bootstrap-owner.js
unset OWNER_EMAIL OWNER_PASSWORD
```

源码检出版本把 `-f docker-compose.images.yml` 换成 `-f infra/compose/docker-compose.yml`。该命令创建普通已验证账号和个人工作区，不授予服务器权限。对已有未验证账号，密码必须匹配才能验证；已有已验证账号保持不变。没有邮件的安装应只放在可信本地网络中。

## 验证与找回密码邮件

已登录用户修改密码不需要邮件配置。只有存在事务邮件提供商时，登录页才会显示找回密码。Rakazo 使用提供商中立契约，支持 Resend API 和 SMTP 适配器。模板本地用 React Email 渲染为 HTML 和纯文本，与发送提供商无关。

使用 Resend HTTP API 时，先验证发送域名，创建仅限该域名的发送 API 密钥，然后配置：

```env
EMAIL_PROVIDER=resend
EMAIL_API_KEY=replace-with-sending-api-key
EMAIL_FROM=Rakazo <hello@mail.example.com>
```

在提供商域名设置中关闭账号邮件的打开和点击追踪。Resend 投递有 10 秒截止时间，并使用同一幂等键进行有限重试，响应丢失时也一样。错误信息不会包含提供商响应体或凭据。

Amazon SES 或其他 SMTP 服务器使用：

```env
SMTP_URL=smtps://smtp-user:replace-with-password@smtp.example.com:465
EMAIL_FROM=Rakazo <no-reply@example.com>
```

设置 `EMAIL_REPLY_TO` 可以让回复发到 `EMAIL_FROM` 之外的地址。

`EMAIL_PROVIDER=smtp` 可省略：未指定提供商时，已有 `SMTP_URL` 会继续选择 SMTP。`EMAIL_PROVIDER=none` 禁用外部发送。显式提供商设置优先于旧的 `SMTP_URL`；不完整或未知的提供商配置会在启动时失败。

Resend 也支持 SMTP：使用 `smtp.resend.com`，用户名为 `resend`，密码为 API 密钥。Amazon SES 请使用区域 SMTP 端点和 SES SMTP 凭据；它们不同于普通 AWS 访问密钥。测试投递前，先在提供商处验证发件人或域名。凭据保存在 `.env`，绝不放在跟踪文件中。`smtps://` 使用隐式 TLS；也支持 `smtp://`，但要求 STARTTLS。Rakazo 会拒绝关闭 TLS 或证书校验的配置。

本地源码开发可以使用离线邮件模拟器，它捕获邮件而不联系提供商：

```env
EMAIL_EMULATOR=true
```

`NODE_ENV=production` 时模拟器被强制禁用，且要求 API 绑定回环地址。在 `NODE_ENV=development` 中，禁用缓存后可从 `http://127.0.0.1:3100/api/dev/emails` 查看捕获邮件；API 只记录投递元数据，不记录重置令牌。测试、预发布和生产环境不会注册收件箱路由。

Rakazo 还可以发送带退订链接的产品邮件：新账号首次登录后的欢迎邮件、开启计费推荐时的推荐邮件，以及配置计费后在套餐开始后发送的提醒。本仓库不包含这些邮件的文案，因此只有在你提供对应文案（并配置上述任一提供商）时，每封邮件才会发送。

文案是一个文件夹，每封邮件一个 `<email>.json` 文件（`welcome`、`referral`、`model-connection`、`agent-import`），把每种应用语言映射到该邮件各个键的字符串。每个字符串必须恰好使用 `packages/auth/src/email-copy/email-keys.ts` 为该键列出的 `{placeholders}`。只有当文件的英文（`en`）为每个键都提供了有效字符串时，该邮件才会发送；其他语言缺失或无效的字符串会回退到该英文。启动时，API 和 worker 会记录每封被关闭的邮件及原因。

应用从 `EMAIL_COPY_DIR`（镜像中为 `/app/email-copy`）读取该文件夹，因此请为 `api` 和 `worker` 服务挂载它，或把 `EMAIL_COPY_DIR` 指向它。`node packages/auth/scripts/check-email-copy.ts <dir>` 会检查一个文件夹。

## 密码策略

新密码（注册、重置和修改）必须为 8 到 128 个字符，没有复杂度规则。可以选择拒绝出现在已知泄露中的新密码：

```env
AUTH_BREACHED_PASSWORD_CHECK_ENABLED=true
```

该设置查询 Have I Been Pwned range API，只发送密码 SHA-1 哈希的前五个字符。默认关闭，因此服务器不会发出外部请求。服务不可达或超过三秒时，密码会被接受，并记录失败。

## OpenID Connect SSO

SSO 兼容自托管或托管的 OpenID Connect 提供商。相关设置留空时，仅保留密码登录。三个凭据必须一起设置在 API 上：

```env
OIDC_ISSUER=https://identity.example.com
OIDC_CLIENT_ID=replace-with-client-id
OIDC_CLIENT_SECRET=replace-with-client-secret
OIDC_NAME=SSO
OIDC_SCOPES=openid email profile
AUTH_PASSWORD_ENABLED=true
OIDC_ALLOW_SIGNUP_BYPASS=false
```

Issuer 必须是 HTTPS，并与发现文档中的 issuer 完全一致。Rakazo 加载 `<issuer>/.well-known/openid-configuration`，用发现 JWKS 校验 ID token 的 issuer、audience 和 nonce，并使用带 PKCE 的授权码流程。额外 scope 可以用空格或逗号分隔；`openid email profile` 总是会请求。`OIDC_NAME` 是按钮标签，默认为 “SSO”。密钥只在 API 上保留；Compose 会清除 worker 的 OIDC 凭据。能力端点只暴露标签、发现可用性和已启用的登录方式。

在提供商处注册这个回调 URI（使用公开的 `BETTER_AUTH_URL` origin）：

```text
https://app.example.com/api/auth/callback/oidc
```

网页、桌面和移动端使用同一个提供商回调 URI。Electron 在共享应用会话的沙箱内嵌弹出窗口中完成 SSO，再返回主窗口。移动端在 API 上完成回调，然后通过 Better Auth 的 Expo 授权代理和原生认证浏览器会话返回 `rakazo://sign-in`（绑定或重新认证时为 `rakazo://account`）。认证服务器信任 `rakazo` 应用 scheme；不要在移动应用中注册客户端密钥。移动端像密码登录一样，把结果会话保存在 SecureStore。原生构建需要 Expo WebBrowser 模块。

提供商邮箱只有在 `email_verified` 为布尔值 `true` 时才算已验证。false 或缺失会保持未验证，后续登录也一样；未验证声明不会更改账号邮箱。登录不会仅凭邮箱自动绑定账号，除了认领[目录供应](#目录供应scim)创建的账号。如果邮箱属于另一个账号，请登录该账号并在账号设置中选择 **Link SSO**。绑定要求已认证会话、提供商邮箱已验证且邮箱一致。有邮件投递时，账号只有邮箱验证后才能绑定 SSO。没有邮件时，未验证账号只能从已登录它的浏览器绑定，移动应用不能绑定。之后用 issuer 和提供商 subject 识别绑定关系。更换 issuer 不会复用旧身份。旧 issuer 的绑定仍会保存，但不算当前提供商的绑定，因此 **Link SSO** 会重新可用。请在已登录的现有账号上绑定新身份；已认证会话、已验证邮箱和邮箱一致的检查仍然适用。恢复旧 issuer 后，它的现有绑定可再次使用。

普通 SSO 登录和绑定可以复用身份提供商的现有会话。它们不能为删除账号提供新的认证证明。账号设置中的显式重新认证流程会请求 `prompt=login` 和 `max_age=0`，把回调绑定到同一个 issuer 和 subject，并要求发起会话保持有效。只有该回调会给结果会话授予证明，在提供商认证后五分钟过期（回调延迟不会延长）。验证过的 ID token 必须包含与请求一致的 `auth_time`（允许 60 秒时钟偏差），且不超过五分钟。缺失、过期或无效声明都会失败。OAuth 回调是一次性的，并发请求也一样。密码验证和邮箱删除验证码仍可用。删除验证码必须通过账号设置或带 CSRF 保护的 `POST /api/auth/delete-user` 提交；GET 删除回调已禁用。

SSO 注册会先遵守关闭注册和部署允许名单，再创建账号。允许名单中的提供商邮箱必须已验证；注册不会绕过邮箱证明。`OIDC_ALLOW_SIGNUP_BYPASS=true` 明确允许 IdP 身份绕过允许名单及其邮箱验证准入要求。只有当 IdP 控制谁能加入该部署时才应启用。它**不会**重新打开关闭的注册，也不会改变邮箱验证声明或绑定规则。已获准的账号在注册关闭时仍可登录。

设置 `AUTH_PASSWORD_ENABLED=false` 可进入 SSO-only 模式。服务端禁用密码登录、注册、密码重置和密码修改端点，登录表单也会隐藏。未完整配置 OIDC 凭据时，API 在该模式下会拒绝启动。发现服务暂时不可用时仍可启动：提供商保持注册，登录返回临时错误，后台重试会自动恢复，无需重启。发现服务在首次使用时懒加载，并在后台刷新；失败最多退避一分钟。可用性反映发现服务状态，不保证提供商 token 端点当前可达。

删除账号时，密码用户仍需密码确认。没有密码的用户可以在五分钟内完成显式组织 SSO 重新认证后删除；**Sign in again** 会发起一个绑定到已登录账号的新提供商往返。选择其他身份无法确认删除，也不能在该流程中创建另一个账号。过期或借用的会话不能授权删除。配置事务邮件后，**Send deletion code** 会向账号邮箱发送一次性验证码，10 分钟有效。在账号设置中输入即可确认删除。邮箱验证码请求有限流；无效、过期或错误账号的验证码都会失败。删除不需要创建密码。

## Google 和 Apple 登录

Google 和 Apple 登录默认关闭，只有在 API 上设置完整凭据后开启。未设置时，登录仍为邮箱密码，以及你已配置的 OpenID Connect 提供商。每个提供商只在自身配置完整时开启。邮箱密码仍显示在按钮旁边。

```env
GOOGLE_CLIENT_ID=replace-with-client-id
GOOGLE_CLIENT_SECRET=replace-with-client-secret

APPLE_CLIENT_ID=replace-with-services-id
APPLE_TEAM_ID=replace-with-team-id
APPLE_KEY_ID=replace-with-key-id
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nreplace-with-key\n-----END PRIVATE KEY-----"
```

一组留空即可保持该提供商关闭。`APPLE_PRIVATE_KEY` 是 Sign in with Apple `.p8` 文件的内容。环境变量中的换行可以是真实换行，也可以是两个字符的 `\n`。如果要挂载文件，请设置 `APPLE_PRIVATE_KEY_FILE` 为路径，并让 `APPLE_PRIVATE_KEY` 留空。只能设置其中一个。所有 Compose 变体中，该路径都在 API 容器内：给 `api` 服务添加只读 bind mount 的 override，例如 `./secrets/apple.p8:/run/secrets/apple.p8:ro`，然后设置 `APPLE_PRIVATE_KEY_FILE=/run/secrets/apple.p8`。基础 Compose 文件不会挂载宿主机密钥。

API 自行签署 Apple 的客户端密钥（使用密钥、team id 和 key id 的 ES256），缓存并在过期前重新签署。Apple 拒绝有效期超过六个月的密钥，因此无需手动轮换，也不需要粘贴客户端密钥 JWT。

使用公开的 `BETTER_AUTH_URL` origin，注册这些回调 URI：

```text
https://app.example.com/api/auth/callback/google
https://app.example.com/api/auth/callback/apple
```

Google 请创建 web OAuth client 并添加回调 URI。Apple 请创建 Services ID（该值是 `APPLE_CLIENT_ID`），启用 Sign in with Apple，并使用同一个回调 URI。密钥在 Keys 下创建并启用 Sign in with Apple；其 id 是 `APPLE_KEY_ID`，team id 在账号页面。`.p8` 只下载一次，与 API 的其他密钥一起保存。

网页、桌面和移动端使用相同回调 URL 的浏览器 OAuth。iOS 在可用时渲染原生 Apple 按钮；它启动浏览器授权，而不是获取裸 identity token。不支持提交原生 token：浏览器流程会把授权绑定到一次性服务器状态和 nonce。App Store 要求提供 Google 的构建也提供 Apple 选项。

已有账号通过账号设置中的已认证绑定连接 Google、Apple 或通用 OpenID Connect。提供商邮箱与账号邮箱相同也不会隐式绑定：历史提供商验证不能证明当前控制另一个服务上的邮箱。

绑定要求提供商已验证邮箱与已验证的 Rakazo 邮箱一致。不同的提供商地址（包括 Apple 的 Hide My Email 中继地址）不能绑定到该账号。

通过 Google 或 Apple 注册遵守与邮箱注册相同的关闭注册和允许名单规则。创建社交账号前，提供商邮箱必须已验证。Google 验证只对 Gmail 或匹配的已验证 Workspace 域名有效。Apple 验证只对 Apple 管理的邮箱和中继地址有效。其他提供商邮箱不能通过社交注册创建账号；请先用邮箱验证账号，再在设置中绑定。

Google 和 Apple 登录及绑定不能确认敏感操作。它们的浏览器会话可能被缓存；账号选择器、授权页或 nonce 不构成新的认证证明。请使用密码、邮箱确认码，或带已验证新 `auth_time` 的组织 OIDC。没有可用确认方式或邮件投递的服务器上，仅社交登录的账号无法自行确认敏感操作，包括删除账号。操作者必须配置一种支持的方式；界面会隐藏不可用选项。

## 目录供应（SCIM）

身份提供商可以通过 SCIM 2.0 把人员加入 Rakazo 或从中移除。生成令牌（`openssl rand -hex 32`）并设置在 API 上：

```env
SCIM_BEARER_TOKEN=<your generated token>
```

在身份提供商中，把 SCIM base URL 设为 `https://app.example.com/api/auth/scim/v2`（你的 `BETTER_AUTH_URL` origin），bearer token 设为该值。该令牌只管理人员；组请求会被拒绝。轮换令牌只需更改值并重启 API。

- **添加人员**会创建带其邮箱的账号，未验证且无密码。即使注册关闭或允许名单会拒绝，它也能加入 Rakazo；因此 `SIGNUPS_ENABLED=false` 加 SCIM 只允许目录分配的人。他们通过 [SSO](#openid-connect-sso) 登录（首次使用相同已验证邮箱的 SSO 登录会认领账号），或使用邮箱登录验证码。
- **已有账号的人**会保留原账号：目录按邮箱接管，不更改其姓名、邮箱或登录方式，随后可以停用它。只有邮箱已验证的账号会被接管。任何人都可能先用无人证明的邮箱注册，因此目录会收到冲突；两个账号邮箱仅大小写不同时也一样。操作者决定如何处理这些账号。
- **停用人员**（`active: false`）或**删除**会立即停用账号。它会结束所有登录和配对计算机，移除通知注册，取消其启动的运行，跳过其例程，并拒绝来自其登录、运行、webhook 投递或已绑定聊天应用的新消息。其机器人、聊天、记忆、文件和连接保留。他们也会像被移除一样离开其他人邀请他们的共享 Space：他们在那里创建的内容转交给 Space 拥有者，那里的例程暂停。他们拥有的 Space 仍归他们所有。重新启用会恢复登录和自己的 Space，其中的例程从下一个计划时间恢复。离开的共享 Space 需要重新邀请。
- 使用相同 external id **再次添加已删除人员**会找到其现有账号。

没有身份提供商时，操作者也可以从 API 容器执行相同操作：

```bash
docker compose --env-file .env -f docker-compose.images.yml exec api \
  node dist/cli/account-status.js deactivate person@example.com   # or reactivate
```

设置 `SCIM_BEARER_TOKEN` 后，该命令会把身份提供商管理的账号留给提供商：不会停用提供商仍启用的人，也不会启用提供商已停用或删除的人。令牌移除后，它可以更改任何账号。同一命令也可完成清理未完成的停用。账号一旦关闭，登录和运行立即被拒绝；如果结束会话、计算机或运行没有完成，API 会用账号 id 记录 `directory.account_change.unfinished`。

停用和重新启用会记录为 `auth.account.deactivated` 和 `auth.account.reactivated` [安全事件](../self-host-observability.md#security-events)，并写入其每个组织的[审计日志](../self-host-audit-log.md)。目录永远不会删除账号或其内容。

## 通行密钥

当 `WEB_ORIGIN` 是 HTTPS 域名（或开发环境的 `localhost`）时，通行密钥自动开启；依赖方是该 origin 的主机，因此 `WEB_ORIGIN` 必须保持同一域名，已有通行密钥才能继续使用。SSO-only 部署关闭密码登录时，通行密钥也关闭。网页上，拥有平台认证器的浏览器会提示使用。macOS 桌面应用使用系统通行密钥面板，它只服务发布版本关联的域名（`app.rakazo.com`），因此对其他服务器会隐藏通行密钥。

原生应用只有在域名为它背书且应用为该域名构建时，才能使用该域名的通行密钥。iOS 应用的关联域名来自构建时的 `EXPO_PUBLIC_API_URL`。macOS 桌面构建来自 `RAKAZO_PASSKEY_RP_ID`（默认 `app.rakazo.com`）：`pnpm build` 和 `apps/desktop/scripts/passkey-entitlements.ts` 都要设置为同一域名，然后用该脚本输出作为 electron-builder 的 `-c.mac.entitlements`，并用带 Associated Domains 能力的 App ID profile 作为 `-c.mac.provisioningProfile`，与发布流程相同。缺少任一项，macOS 都会忽略关联，应用会隐藏通行密钥。当 Apple CDN 无法访问服务器（私网或 Tailscale 等 VPN）时，任一构建还要设置 `RAKAZO_PASSKEY_DEVELOPER_MODE=1`：开发签名应用会自行获取关联文件，前提是开启关联域名开发者模式（iOS 在 Settings > Developer，macOS 运行 `sudo swcutil developer-mode -e true`，且应用必须位于 `/Applications`）。要让构建使用这个服务器的通行密钥，请设置：

```bash
# iOS 和 macOS 桌面应用（dev.rakazo.desktop）：<Apple Team ID>.<bundle id>，逗号分隔。
# 通过 /.well-known/apple-app-site-association 提供。
PASSKEY_APPLE_APP_IDS=ABCDE12345.com.rakazo.app,ABCDE12345.dev.rakazo.desktop
# Android：应用签名证书的 SHA-256 指纹，逗号分隔。
# 通过 /.well-known/assetlinks.json 提供，并作为通行密钥 origin 接受。
PASSKEY_ANDROID_CERT_SHA256=AA:BB:...:FF
```

在某平台设置配置前，该平台的原生应用会隐藏这个服务器的通行密钥。两个文件都通过网页 origin 提供，因此网页容器前的反向代理必须把 `/.well-known/` 转发给它。
