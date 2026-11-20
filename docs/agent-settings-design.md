# Agent 详细设置功能设计

状态：2.2 本机指派、2.3 专属工作区已实现（P2、P1）；其余为草案。逐项对照"agent 设置"期望
的六项能力：头像、名称、电脑选择（云上 / 本地）、专属工作区 / 文件夹、权限设置、线程（多
线程）数。每一项给出现状（含代码依据）、差距、功能设计与验收口径。

## 1. 现状盘点

| 能力                | 现状                                                                        | 依据                                                                                                                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 名称 / 头像         | 已实现（无需新工作）                                                        | `Bot.name`、`Bot.color`、`Bot.avatarSet`（`packages/db/prisma/schema.prisma`）；创建与更新走 `CreateBotInput` / `UpdateBotInput`（`packages/contracts/src/bots/bot.ts`）；设置页已有"Name and avatar: pick a shape and color, or upload an image"（`docs/bots-and-chats.md`）     |
| 电脑模式            | 只有云上两档：team / dedicated                                              | `ComputerModeSchema = z.enum(["team", "dedicated"])`（`packages/contracts/src/computers/computer.ts:6`），RPC `bots.setComputer`（`packages/contracts/src/bots/bots-rpc.ts:77`）                                                                                                  |
| 本地电脑            | 账号级配对授权，无 per-bot 指派                                             | `UserDeviceGateway`（`packages/adapters/src/computers/host/user-device-protocol.ts`）按 `userId` 取设备，省略 `deviceId` 时用"最早已配对且在线"的一台；本地 server 的 "Use this Mac" 是 deployment 级开关（`computerHost`，见 `host-computer-device.ts`）                         |
| 专属工作区 / 文件夹 | 默认目录存在，不可配置                                                      | team 模式固定 `bots/<botId>`，dedicated 为整机 home；解析在 `resolveBotWorkspaceCwd` / `resolveBotUploadPath`（`packages/adapters/src/computers/screens/computer-support.ts:114`）                                                                                                |
| 权限                | 审批模式是 Space 级；per-bot 仅有零散开关                                   | `ApprovalModeSchema` 注释"How much a space asks before acting"（`packages/contracts/src/integrations/approvals.ts:14`）；Allow/Block 规则按用户存（`UserActionApprovalRule`）；per-bot 现有 `crossSpaceCommunication`、`fleetManagement`、`disabledBuiltinTools`、`dailyCheckIns` |
| 线程 / 多线程       | 一个 bot 一条主会话 + 运行中消息 steering + 后台 helper；无任何并发上限字段 | `Thread.botId @unique`（schema.prisma）；`Bot.helperThreads`；"A bot uses its computer for one run at a time. A message sent while a run is going steers that run instead of waiting."（`docs/run-execution.md`）                                                                 |

两条硬约束贯穿全部设计：

- 不做假开关：后端与契约没有的能力，不出现在 UI。
- AGENTS.md 原则：never make agent runs or LLM calls wait for a queue, a worker slot,
  a global concurrency cap, or a polling loop。任何"槽位"式设计都要与它对齐或
  显式豁免。

## 2. 功能设计

### 2.1 名称与头像（已有，收口即可）

现状即目标：设置页可改名、选形状与颜色或上传图片，bot 在会话里也能自改并带
Undo。本项无契约与后端工作。若要在"创建 agent"流程里暴露头像，复用现有
`avatar-studio-popover` 与 `CreateBotInput.color / avatarFamily`，属纯前端小改。

### 2.2 每台 Agent 的电脑选择（云上电脑 / 本地电脑）（已实现）

**目标**：在 bot 设置里把"用哪台电脑"从 Space/deployment 级下沉到 bot 级：云上
Team（默认）、云上 Private（dedicated）、或"我的某台已配对电脑"。

> 实现注记：落地时修正了草案的两处过度设计。其一，绑定不改变 bot 自己的云端电脑
> （scope 仍是 team/dedicated），它钉住的是 bot 的"用户电脑"工具（shell / 应用 /
> 屏幕）走哪台已配对机器——这正是"让 bot 用我的电脑"的语义，云端电脑继续承担 bot
> 自己的文件、浏览器与屏幕。其二，设备属主不必单独存列：保存时只接受 bot 属主账号
> 名下的未撤销设备，属主恒等于 `bot.userId`，运行期由它路由，少一列就少一处过期
> 数据。设备被撤销 / 删除时绑定自动失效为"离线"，绝不回退到别的机器。

**概念分层**（这是设计的关键决策点）：

- `scope`（team / dedicated）表达存储与隔离范围，保持不动；
- 新增 placement 维度：云端（现状）或绑定到一台已配对设备。不扩展
  `ComputerModeSchema`，避免把两个维度揉进一个枚举；本地执行时
  `ComputerStatus.runsOnUserMachine` 已能向客户端表达"没有远程屏幕"。

**数据模型**（additive migration，安全）：

- `Bot.hostDeviceId String?`：已配对设备 id（来自 `UserDeviceGateway.list`）。
- `Bot.hostDeviceOwnerId String?`：设备属主账号。设备配对挂在账号上
  （`user-device-protocol.ts` 的 `connected(userId, deviceId)`），绑定必须记住
  属主，否则换人触发 run 时无法路由。

**契约**：

- `BotSchema` 增加 `hostDevice: { deviceId: string; name: string; online: boolean } | null`
  （名称与在线状态由服务端从 gateway 解析后下发，客户端不存 raw id 直接显示）。
- `UpdateBotInput` 增加 `hostDeviceId: Id | null`；置 null 即回到云端。
- 设备列表复用现有配对查询，不新增 RPC；若设置页需要，新增
  `computers.listPairedDevices`（只读、按当前用户授权）。

**执行路径**：run 装配处现在按 `userComputerOwnerId` 调
`userDevices.connected(userId)`（`run-assembly-capabilities.ts:577`）。改为：bot
绑了设备时，用 `connected(hostDeviceOwnerId, hostDeviceId)` 显式指定；显式设备不可
用绝不回退到别的设备（gateway 的契约注释已保证这一语义），run 以明确错误结束并在
会话里给出可读原因，而不是悄悄改跑云电脑——本机与云沙箱的文件/登录态边界不同，
静默换边是安全问题。

**多人 Space 语义**（必须写死在文档里的决策）：

- 绑定本地设备的 bot，其本机执行只对设备属主发起的 run 生效；
- 其他成员触发时：命令工具走该 bot 在 Space 里的云端电脑（team/dedicated 不变），
  本机屏幕/应用工具对该 run 不可用。与现状"bots use your apps only in chats you
  start with your own bots"（`docs/computer.md`）一致；
- 设置页对非属主成员显示设备名但禁用切换，并说明属主。

**UI**：bot 设置 Advanced → Computer 由两档变为：Team（默认）/ Private / 一台本地
电脑（下拉列出该用户的已配对设备，离线设备置灰标注）。移动端同一契约只读展示，
编辑放后一期。

**工作量**：中（契约 + 迁移 + executor 路由 + web 设置页 + 状态显示），约 0.5–1 天。

### 2.3 专属工作区 / 工作目录（已实现）

**目标**：每个 bot 可配一个"工作目录"，它的命令默认在此 cwd 下执行；用户控制时
的允许写目录也随之限定。

> 实现注记：按本节落地，另有两点超出草案描述——账号导出 / 导入会随 bot 记录往返
> 该设置；设置保存后在运行中的电脑上立即建目录（不等下次启动），提示语在 bot 下次
> run 起生效。

**数据模型 / 契约**：

- `Bot.workspacePath String?`（additive migration；null = 现状默认）。
- `BotSchema.workspacePath: string | null`；`UpdateBotInput.workspacePath` 可置空
  清除。

**解析改动**（单点收口，不集中就会漏白名单）：

- `resolveBotWorkspaceCwd` / `resolveBotWorkspacePath` /
  `resolveBotUploadPath`（`computer-support.ts`）增加 base 参数：
  `base = bot.workspacePath ?? 现状默认`（team：`bots/<botId>`；dedicated：home 根）。
  相对 cwd 继续相对 base 解析；`..` 越界继续抛 `WorkspacePathError`。
- 上传写白名单从"bot 目录 + `shared/`"变为"workspacePath（或其默认目录）+
  `shared/`"，语义不变、只换锚点。

**校验规则**（按三种 placement 分别定）：

- 云上 team / dedicated：只允许相对路径，规范化后不得以 `..` 开头；拒绝绝对
  路径，避免 bot 之间互相指到对方的目录。
- 本机（2.2 绑了设备）：允许绝对路径与 `~`（`expandHomePrefix` 已有展开），因为
  本机的意义就是"用你自己的文件夹"；此时该字段在 UI 上标为"这台电脑上的文件夹"。

**建目录**：保存设置与 bot 首次使用电脑时 ensure 一次。复用
`manageComputerWorkspaceDirectories` 的 `ensure` 动作（
`computer-workspace.ts:574`），不要新开一条建目录路径。

**UI**：bot 设置 Advanced → 工作区：一行文本框 + 说明"留空使用默认"；改动在电
脑下次启动生效，不迁移旧文件（旧目录保留，bot 可自行搬运）。

**工作量**：中，约 0.5 天。建议排在 2.2 之前交付，它不依赖设备绑定。

### 2.4 Agent 级权限设置（已实现）

**目标**：制一个"权限"区块收拢现有 per-bot 开关（`crossSpaceCommunication`、
`fleetManagement`、`disabledBuiltinTools`），并新增**审批模式覆盖**：默认"跟随
Space"，可单独把某个 bot 调成 ask / auto / never。

> 实现注记：审批模式在唯一判定点（`run-tool-gate`）读取 `bot.approvalMode ?? Space
> 模式`，Block 规则始终优先；Auto 无审批模型时由 `planActionGate` 的
> `checkerConfigured` 自然退化为 ask，设置页在此时显示原因，不需要额外调度改动。
> 权限区块（含模式选择器）在 web 与移动端改为常驻，零散开关仍只在改动后显示。

**数据模型 / 契约**：

- `Bot.approvalMode String?`（null = 跟随 Space；additive migration）。
- `BotSchema.approvalMode: ApprovalModeSchema | null`；`UpdateBotInput.approvalMode`。
- 简化入项：`bot-settings-layout.ts` 的 advanced 列表把三个开关与新模式收进
  `permissions` 分组，web / 移动端按同一 layout 渲染。

**判定顺序**：工具的审批判定处读 `bot.approvalMode ?? spaceMode`。两个边界要
写死：

- Auto 仍依赖 Space 配置的 approval model；没有该模型时 per-bot 选 Auto 要回退
  ask 并在设置里说明，不能让 run 悄悄等同 never。
- 方向不受限（可调松也可调紧），因为 per-user 的 Block 规则始终优先（
  "A blocked action is refused without a card, in every mode"）。
  风险较高的是调松，PR 的 Risk 里要说明。

**工作量**：小–中，约 0.5 天（大头在审批判定路径的回归测试）。

### 2.5 线程 / 多线程（默认 3）（已实现）

**先决：这一项必须先有产品定义，再动代码。** "一个 bot 一条持续会话，运行中的
消息 steering 进去"是 Rakazo 的既有模型（`docs/run-execution.md`）；Codync 类产
品的"每 agent 3 个并行槽"是本地多 agent 模型，两者不同源。直接把"线程数 = 并行
run 上限"搬过来与 AGENTS.md 的核心原则（不让 run 等空槽、不设全局并发上限）
正面冲突，不做。

> 实现注记：落地时发现该护栏已存在——后台 helper 一直有 bot 级并发上限，只是硬编
> 码为 4（`MAX_PARALLEL_SUBAGENTS`），在 bot 行锁的事务里计数，超出时回一句"已经有
> N 个在跑，先结束本轮"。本次把常量改为契约里的默认 3（`DEFAULT_MAX_CONCURRENT_HELPERS`），
> 新增 `Bot.maxConcurrentHelpers`（1–8，null = 默认）覆盖，判定与提示文案复用原路径，
> 仍然不排队、不阻塞主对话。

**推荐定义（方案 B）**：把"线程"定义为**该 bot 可同时展开的后台 helper（
subagent / helper thread）的数量上限，默认 3**。它与现有模型同源：helper 本就有
独立 thread（`Thread.helperBotId` / `Bot.helperThreads`），用户感知为"这个 agent
同时帮我并行推进几件事"，而不是"消息排队"。

设计要点：

- 数据模型：`Bot.maxConcurrentHelpers Int?`（null = 用部署默认 3；additive）。
- 调度：helper 启动处计数该 bot 的活跃 helper 数；超出上限时**不排队、不阻塞
  主对话**——新任务作为提示回给模型（"最多同时 N 件并行工作，先收口一件"），由
  模型自己决定合并或等待。这样上限是约束 agent 行为的护栏，不是要 run 等的
  槽位，与并发原则不冲突。
- UI：bot 设置 Advanced → 并行工作：数字输入，默认 3，范围 1–8；附一句"同时
  并行推进的后台任务数"。
- 明确不做：消息排队槽、主对话并发 run、全局并发上限。若产品要的是"一个
  bot 多条独立会话主线"，那是另一个大特性（动 `Thread.botId @unique` 与全部会
  话路由），单独立项，不在本文档范围。

**工作量**：产品定义 0.5 天 + 实现约 1 天（调度与计数要为多进程正确做在原
子计数/事务里）。

## 3. 分期交付

- **P0（纯前端，0.5 天）**：设置页收拢——名称/头像保持现状；权限区块按 2.4 的分
  组先把三个既有开关归位，不加新能力。
- **P1（约 0.5 天，已完成）**：2.3 专属工作区——契约 + 迁移 + 路径解析 + web / 移动设
  置页 + 账号导出导入往返。
- **P2（约 0.5–1 天，已完成）**：2.2 本机电脑指派——契约 + 迁移 + 运行期钉住 + web
  选择行 + 移动端只读展示。
- **P3（约 0.5 天，已完成）**：2.4 的审批模式覆盖——契约 + 迁移 + 判定点 + web /
  移动端选择器 + 账号导出导入往返。
- **P4（已完成）**：2.5 并行 helper 上限——契约 + 迁移 + 运行期上限 + web / 移动端
  输入 + 账号导出导入往返。

## 4. 风险与开放问题

- 本机执行与云沙箱的文件/登录边界：2.2 的设备不可用策略必须是"明确失败"，绝不
  静默回退；这是安全边界。
- 多人 Space 里看到"别人的电脑"：状态展示与禁用逻辑要跟上，否则等于泄露他人设
  备名。设备名属用户数据，不在日志与公开 PR 文案出现。
- 审批模式调松的暴露面：per-bot never 会让该 bot 的所有动作免审（Block 规则除
  外），PR 需带 Risk 段。
- 迁移：本设计全部为加列（`hostDeviceId`、`hostDeviceOwnerId`、`workspacePath`、
  `approvalMode`、`maxConcurrentHelpers`），与滚动发布兼容；无 drop，无需
  `-- deferred` 迁移。
- 开放问题：per-bot 审批模式是否允许超过 Space 模式？"线程数"是否采用 2.5 的
  helper 语义？这两个答案落在实现 PR 描述里。
