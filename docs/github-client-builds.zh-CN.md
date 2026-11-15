# GitHub 四平台测试构建

`BotONE client test builds` 在 GitHub 托管机器上实际编译 Android、iOS、macOS 和 Windows，不调用 EAS 云构建。只接受手动触发，不监听代码提交、PR、标签或定时事件。Android、macOS 和 Windows 安装包在构建成功后自动保存到 GitHub Pre-release；iOS 只保留 Actions 产物。不上传商店或发布 OTA。

## 手动运行

工作流合并到默认分支后：

1. 打开自己的仓库，进入 **Actions → BotONE client test builds**。
2. 点击 **Run workflow**，选择包含该配置的分支。
3. 在 `platform` 选择 `android`、`ios`、`macos`、`windows`，或选择 `all`。
4. Android、macOS 和 Windows 构建结束后，在 **Publish preview downloads** 的运行摘要打开下载链接，或到仓库 **Releases** 下载。每次运行对应 `botone-preview-运行编号`，标记为 Pre-release，不替换正式版的 Latest。
5. iOS 模拟器包仍在该次运行底部的 **Artifacts** 下载，保留一天，不上传 Release。只选择 iOS 时不会创建 Release。

Release 附件不使用 Actions 的一天保留期，可以长期下载；不要删除需要保留的 Release 或附件。其余平台也会保留一天的 Actions 产物，供发布步骤读取。某个平台失败不会阻止发布其他已成功上传的安装包；全部失败时不创建空 Release。重跑同一次运行的发布 Job 会补充或替换同名附件。

发布步骤使用工作流自带的 `GITHUB_TOKEN`，只有独立发布 Job 取得 `contents: write` 权限，无需新增个人访问令牌。安装包仍使用下表的测试签名，进入 Releases 不代表已经具备正式签名。

命令行也可以手动触发，`OWNER/REPO` 替换为自己的仓库：

```sh
gh workflow run botone-build-clients.yml --repo OWNER/REPO --ref main -f platform=android
```

新工作流在默认分支出现前，GitHub 可能不显示手动运行入口。只把工作流推到功能分支并不代表已经可以在 Actions 页面运行。

## 各平台的产物和边界

| 平台 | Runner | 产物 | 如何测试 |
| --- | --- | --- | --- |
| Android | Ubuntu | 含 JS 的 Release APK，使用开发签名 | 下载并解压 Artifact，将 APK 安装到 Android 手机或模拟器；不依赖 Metro |
| iOS | macOS | 含 JS 的 Release 模拟器 `.app` ZIP | 解压后在 Mac 的 iOS Simulator 安装；不能安装到 iPhone，也不能上传 TestFlight |
| macOS | macOS | Apple silicon 与 Intel 通用 DMG、ZIP | 本机测试；仅临时签名，没有 Developer ID 签名或 Apple 公证，系统可能阻止打开 |
| Windows | Windows | x64 NSIS EXE 安装包 | 本机测试；未做公开代码签名，Windows 可能提示未知发布者 |

测试包使用独立标识：移动端为 `dev.botone.preview`，桌面端为 `dev.botone.preview.desktop`。它们不是生产应用标识，正式发布前需要确认自己的应用标识和长期签名方案。Android 开发密钥不用于正式发行，也不要用测试包覆盖现有生产安装。

桌面包的应用名称和运行时名称为 `BotONE Preview`，使安装器和 Electron 分别使用独立的应用位置与默认用户数据目录，避免测试包替换正常安装或写进正常安装的数据目录。

在 Mac 上安装 iOS 模拟器包：

```sh
# 在 Simulator 中先启动一个兼容的模拟器，再运行：
xcrun simctl install booted /path/to/BotONE.app
xcrun simctl launch booted dev.botone.preview
```

macOS 测试包不含上游发布流程的服务器下载描述文件。本地服务可使用已有的 Docker 方式，或连接已经部署的服务器。

## 后端地址

四种测试构建都不要求 `EXPO_TOKEN`、Apple 分发证书或 Windows 签名服务。

移动端默认地址为 `http://127.0.0.1:3100`。这是手机或模拟器自身的回环地址，不是部署服务器；在真机上测试时，应在登录界面选择可访问的服务器，或提前设置默认地址。

要预设地址，在 **Settings → Secrets and variables → Actions → Variables** 新建 Repository variable：

| 名称 | 示例 |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | `https://app.example.com` |

也可使用同名 Repository secret；两处都设置时，优先使用 Variable。配置修改后需重新启动构建才会写入新包。

桌面测试包也读取此地址，首次启动直接连接自己的服务器；之后保留用户已保存的服务器选择。桌面打包必须配置该值，避免首次启动意外连接上游服务。登录选项及页面 Logo 由所连接的服务器提供；只显示 SSO 登录需要服务器设置 `AUTH_PASSWORD_ENABLED=false` 并配置 OIDC，见[账号配置](self-host-accounts.md#openid-connect-sso)。

该地址会进入客户端，并不是秘密。只填普通服务器地址，不得带密码、Token 或私人链接；不要把真实部署配置提交到 Git。

移动端在一次性 CI checkout 中转换配置：清除上游 Expo 项目归属与推送项目关联，关闭 OTA，修改测试包名及分享 App Group，使用运行编号作为构建号。仓库中的上游 `app.json`、`app.config.ts` 和 `eas.json` 不改动。远程推送暂不启用，本地通知不受此配置限制。

测试包保留客户端与服务器约定的 `rakazo://` SSO 回跳协议。测试设备应只安装一份使用该协议的应用，避免系统将登录回跳交给另一份应用。

桌面端通过单独的 electron-builder 配置关闭更新源，并在打包后检查不存在 `app-update.yml`，避免测试安装意外下载上游更新。

## 与上游发布流程并存

保留上游源文件，日常只运行 `BotONE client test builds`。不要为测试构建启用 `MOBILE_PUBLISH_ENABLED` 或 `DESKTOP_PUBLISH_ENABLED`，也不要设置 `EXPO_TOKEN` 来绕过上游工作流检查。

如果不需要上游发布入口，可以在 Actions 页面分别打开 `release-mobile`、`release-google-play`、`release-android-apk`、`release-desktop`，通过菜单选择 **Disable workflow**。这只改仓库设置，不改上游文件；需要时可以重新启用。

## 排队和正式签名

各平台独立执行，某个平台失败不取消其他平台；只选择需要的平台可以减少无效构建。GitHub 托管 macOS 机器仍可能排队，升级普通会员并不保证立刻分配机器。工作流中的运行超时不等于等待 Runner 的超时。

当前只验证无商业签名凭据的测试构建。iPhone 真机分发、TestFlight、macOS Developer ID、公证和 Windows 代码签名需要另外接入；准备 Apple 材料请见 [Apple 开发者申请与签名准备](apple-developer-setup.zh-CN.md)。

参考：[GitHub Runner 说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[Expo 自行编译发布包](https://docs.expo.dev/guides/local-app-production/)。
