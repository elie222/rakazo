# GitHub 四端正式构建

四个独立入口均在 Actions 中手动点击 **Run workflow**，选择构建分支。不监听 push、PR 或 tag，不自动提交商店审核。原有上游发布流程继续关闭；测试包仍使用 `BotONE client test builds`。

| Actions 名称 | 产物 | 保存位置 |
| --- | --- | --- |
| BotONE Android release | 正式密钥签名 APK、AAB | APK 上传独立 GitHub Release；APK/AAB 保留在 Actions 7 天 |
| BotONE iOS release | App Store Connect 分发签名 IPA | 仅 Actions，保留 30 天；不上传 GitHub Releases |
| BotONE macOS release | Developer ID 签名、公证的 Universal DMG、ZIP | 独立 GitHub Release；Actions 7 天 |
| BotONE Windows release | 暂未签名的 x64 EXE | 独立 GitHub Release；Actions 7 天 |

Android/iOS 的 `build_number` 可留空，默认使用该 workflow 的运行编号。更新已有商店构建时填写比已上传版本更大的编号。IPA 供后续上传 App Store Connect/TestFlight，不能直接安装到普通 iPhone。

每个桌面端及 Android 使用独立 Release 标签，重试同一次运行会更新其下载文件。不会修改 GitHub 的 Latest 标记，也不接入上游自动更新源；后续更新手动下载安装。

## Repository Variables

在 Settings → Secrets and variables → Actions → Variables 中配置：

| 名称 | 用途 |
| --- | --- |
| EXPO_PUBLIC_API_URL | 默认服务器 HTTPS 根地址；兼容同名 Repository Secret |
| BOTONE_MOBILE_APP_ID | Android/iOS 应用 ID，例如 `work.example.bot` |
| BOTONE_DESKTOP_APP_ID | 桌面应用 ID，例如 `work.example.bot.desktop` |

构建只修改 runner 的临时 checkout，不将应用 ID、服务器地址或签名资料写回 Git。移动端不连接上游 OTA 或推送项目；既有登录回调协议保持不变。

## Repository Secrets

### iOS

- `APPLE_TEAM_ID`
- `IOS_DISTRIBUTION_P12_BASE64`
- `IOS_DISTRIBUTION_P12_PASSWORD`
- `IOS_MAIN_PROFILE_BASE64`
- `IOS_WIDGET_PROFILE_BASE64`
- `IOS_SHARE_PROFILE_BASE64`
- `IOS_NOTIFICATION_PROFILE_BASE64`

四个描述文件均使用 App Store Connect 分发类型，分别对应主应用、`.widgets`、`.expo-sharing-extension`、`.notifications`。需要与同一个分发证书和 Team 匹配，并启用原生项目使用的能力。分享扩展的 App Group 为 `group.<BOTONE_MOBILE_APP_ID>`。构建校验描述文件有效期、应用 ID、Team 和证书；临时钥匙串和导入文件在结束时清理。

### macOS

- `MACOS_DEVELOPER_ID_P12_BASE64`：带私钥的 Developer ID Application P12
- `MACOS_DEVELOPER_ID_P12_PASSWORD`：P12 密码原文
- `APP_STORE_CONNECT_API_KEY_BASE64`：公证 API `.p8` 文件的 Base64
- `APP_STORE_CONNECT_KEY_ID`：Key ID 原文
- `APP_STORE_CONNECT_ISSUER_ID`：Issuer ID 原文

兼容已配置的上游名称 `DESKTOP_MAC_CSC_LINK`、`DESKTOP_MAC_CSC_KEY_PASSWORD`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`，优先使用上面的名称。

### Android

- `ANDROID_KEYSTORE_BASE64`：JKS/keystore 文件 Base64
- `ANDROID_KEYSTORE_PASSWORD`：keystore 密码原文
- `ANDROID_KEY_ALIAS`：密钥别名
- `ANDROID_KEY_PASSWORD`：密钥密码原文

已发布的应用必须继续使用匹配的签名密钥；首次发布才创建新密钥。不会使用测试 keystore 代替缺失的正式签名。

### Windows

当前暂不签名，仅需配置通用的 `EXPO_PUBLIC_API_URL` 和 `BOTONE_DESKTOP_APP_ID`，无需 Azure 签名参数或 `desktop-release` environment。生成的 EXE 上传独立 GitHub Release，并注明未签名；Windows 可能显示未知发布者或 SmartScreen 提示。

这些流程不需要 `EXPO_TOKEN`、`DESKTOP_PUBLISH_ENABLED` 或 `MOBILE_PUBLISH_ENABLED`。
