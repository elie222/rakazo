# 无影云电脑

[English](./wuying-computers.md) | [简体中文](./wuying-computers.zh-CN.md)

Bot 可以把一台现有的[无影云电脑](https://www.aliyun.com/product/ecs/gws)（Windows）当作自己的电脑：
在上面执行 PowerShell 命令、读写文件、看屏幕、操作鼠标和键盘；你也可以在 Rakazo 里观看或接管屏幕。

## 整体结构

| 组成部分             | 作用                                                                       |
| -------------------- | -------------------------------------------------------------------------- |
| ECD API（AccessKey） | 查询云电脑状态、开机、签发一次性的屏幕登录码                               |
| 云电脑的 MCP 网关    | 执行命令、读写文件、截屏、发送鼠标和键盘输入                               |
| 无影 Web SDK         | 在电脑面板里显示实时画面，由 Rakazo 在 `/computer-screen/screen.html` 提供 |

每台 bot 电脑的 home 是云电脑上的一个文件夹：`%USERPROFILE%\rakazo\<home>`。文件保存在云电脑自己的磁盘上。
所有 bot 电脑共用这台云电脑，所以只有最后一台使用它的电脑停止时，Rakazo 才会关机；有电脑需要时再开机。删除 bot 电脑只会删掉它的 home 文件夹，不会删除云电脑本身。

## 准备工作

需要准备：

1. **一台无影云电脑**（Windows），已经创建好并**分配给一个终端用户**（例如便捷用户）。屏幕登录码就是为这个用户签发的。
2. **一个 RAM 用户的 AccessKey**，授予 `ecd:DescribeDesktops`、`ecd:StartDesktops`、`ecd:StopDesktops` 和
   `appstream-center:GetAuthCode` 权限，不要给更多。
3. **云电脑的 MCP 网关地址和 Bearer Token**。网关需要提供 `wuying-system-tool` 这组工具
   （`process_exec`、`fs_*`、`screen_capture`、`input_*`、`app_start`）。
4. **Web SDK 文件**。这些文件不在仓库里，构建或启动 web 前先下载固定版本，脚本会校验每个文件的 SHA-256：

   ```bash
   node scripts/wuying-web-sdk.mjs
   ```

## 在设置里配置

管理员不用改环境变量，就能把新电脑切换到无影。

1. 先把自己设成管理员：把账号邮箱写进 `.env` 的 `RAKAZO_ADMIN_EMAILS`，设置 `COMPUTER_SETTINGS_ENABLED=true`，然后重启 API。这个邮箱必须是已验证的。
2. 打开 **设置 → Computer**。
3. 在 **New computers run on** 里选 **Wuying**。
4. 填写云电脑 ID、终端用户 ID、地域（默认 `cn-hangzhou`）、AccessKey ID 和 Secret、MCP 网关地址和 MCP Token，然后点 **Save**。

保存前会先检查：AccessKey 能否查到这台云电脑并签发屏幕登录码；如果云电脑正在运行，MCP 网关能否响应。任何一项失败都不会保存。
连接信息用部署的 `ENCRYPTION_KEY` 加密保存，AccessKey Secret 和 MCP Token 保存后不会再显示。
以后只想改其他字段时，密钥字段留空即可，会继续使用已保存的值。换了 MCP 网关地址时，需要重新填写所有密钥。URL 和 Token 分别填写；网关必须使用 HTTPS 和公网地址。

选择 **Default** 会让新电脑回到 `SANDBOX_PROVIDER` 指定的沙箱，并删除已保存的无影连接；
还在无影上的电脑下次用到时会在默认沙箱上重新启动。

### 每个账号用自己的云电脑

每个账号都可以在 **设置 → Computer** 配置自己的电脑；管理员展开部署表单下的 **My computers**。
此表单设置账号自己的 Team Computer 跑在哪里：
选 **Default** 就用部署默认的电脑（上面管理员的选择，或 `SANDBOX_PROVIDER`）；
选 **Wuying** 就用这个账号自己的云电脑、自己的 AccessKey 和 MCP 网关。保存前同样会先检查。

连接信息保存在账号上，不属于某个空间，其他人都读不到。Team Computer
会在下次启动时换过去，留在原来云电脑上的文件仍在那里。Private Computer 始终用部署默认的电脑。切回 **Default** 会删除已保存的连接。
只有部署提供电脑、并且 `SANDBOX_PROVIDER` 不是 `desktop` 或 `fake` 时，账号才能选择自己的云电脑。

## 用环境变量配置

在 API 和 worker 上都设置 `SANDBOX_PROVIDER=wuying`，以及：

| 变量                                                | 说明                                 |
| --------------------------------------------------- | ------------------------------------ |
| `WUYING_ACCESS_KEY_ID` / `WUYING_ACCESS_KEY_SECRET` | RAM 用户的 AccessKey                 |
| `WUYING_REGION_ID`                                  | 默认 `cn-hangzhou`                   |
| `WUYING_DESKTOP_ID`                                 | 云电脑 ID                            |
| `WUYING_END_USER_ID`                                | 云电脑分配给的终端用户               |
| `WUYING_MCP_URL` / `WUYING_MCP_TOKEN`               | 云电脑的 MCP 网关地址和 Bearer Token |

设置里保存的连接优先于这些环境变量，已经在无影上的电脑也会改用它。`SANDBOX_PROVIDER` 是 `desktop` 或 `fake` 时，设置里的选择不起作用。

## 屏幕隔离

SDK 的本地模式在屏幕页内加载 `/computer-screen/sdk/ASP/container.html`。屏幕页没有
`allow-same-origin`，其不透明来源无法匹配运行时的 `frame-ancestors 'self'`。
只有这个精确路径省略祖先限制与 X-Frame-Options；其他 `/computer-screen/` 路径仍限制为同源嵌入。
运行时仍受沙箱 CSP 限制，服务器不会给它发送凭据；屏幕登录码由已登录的应用传入。
只有嵌套运行时允许连接到 `*.wuying.aliyuncs.com` 任意端口的 TLS WebSocket，
因为云电脑登录票据可能指定 443 以外的网关端口。MCP 网关端口与此无关。

## 限制

- **Private Computer 也共用这台云电脑。** 无影没有按电脑分配的机器，所以无影上的 Private Computer 和用这个提供方的其他电脑共用同一台云电脑和同一个 Windows 账号。
- **一台云电脑一个 Windows 账号。** 用同一台云电脑的所有账号（包括所有用部署默认的账号）共用它的文件、屏幕、
  键鼠输入和命令环境，包括保存的命令凭据。只用来观看的屏幕登录码，在 Rakazo 之外也能操作云电脑。
  给每个人配自己的云电脑，或者只和彼此信任的人共用一台。
- **同一时间只能有一个人看屏幕。** 无影每个终端用户只允许一个会话。在第二个浏览器或无影客户端里打开同一台云电脑，
  会把另一边挤下线。屏幕断开后 Rakazo 最多每 30 秒自动重连一次；超过次数或标签页在后台时，会等你点**重新连接屏幕**。
- **网关的调用上限。** 每次调用最长 1 分钟、命令输出最多 16 KB、列目录最多 1000 项。允许超过 50 秒的命令会转到后台运行，
  输出写进 `%USERPROFILE%\rakazo\.runs`，每秒读一次，照样能实时看到输出。
- **按键。** 单个按键直接走网关；Ctrl+A 这类组合键通过一个没有窗口的脚本调用 Windows SendKeys 发送，每次大约 1 秒。
  不支持 Win 键组合。
- **不支持快照**，也不支持横向滚动。

## 常见问题

| 现象                                                                   | 原因和解决办法                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 电脑面板一直是空白                                                     | 运行 `node scripts/wuying-web-sdk.mjs`，页面需要 `WuyingWebSDK.js` 和 `sdk/ASP/container.html`                         |
| 画面连上后很快断开                                                     | 有另一个查看端占用了会话，关掉另一个面板或无影客户端                                                                   |
| 保存时提示 `Could not reach the Wuying desktop`                        | 检查 AccessKey 权限、地域和云电脑 ID；云电脑运行时，MCP 网关必须能响应                                                 |
| 中文输出是乱码                                                         | 命令没有经过 PowerShell。Rakazo 会把 PowerShell 的输出切换成 UTF-8，其他 shell 仍使用系统代码页                        |
| 设置里没有切换沙箱的选项                                               | 在 API 上设置 `COMPUTER_SETTINGS_ENABLED=true`；部署表单还需要管理员账号，检查 `RAKAZO_ADMIN_EMAILS`，并确认邮箱已验证 |
| 连接 OpenAI 或 Anthropic 时返回 `unsupported_country_region_territory` | 这是模型提供方的地区限制，与无影无关：rakazo 后端所在网络的出口地区不受支持                                            |

## 升级现有部署

静态屏幕页现位于 `/computer-screen/`。构建前重新运行 SDK 下载命令，将文件写入新目录。
API 每次生成新的登录票据，客户端使用当前屏幕路径，不需要回填数据库 URL。升级后重新打开电脑面板。

现有 Caddy 配置须将 `/wuying/sdk/ASP/container.html` 例外改为
`/computer-screen/sdk/ASP/container.html`，并在升级时重新加载配置。默认 updater 不重建 Caddy；
可在 `RAKAZO_UPDATE_SERVICES` 中加入 `caddy`，或手动重建。旧 matcher 会给新运行时添加
X-Frame-Options，阻止不透明来源的嵌套页面。
