# Agent 详细设置：设计与执行计划

状态：名称 / 头像、专属工作区、本机电脑指派、每 bot 审批模式、并行后台工作、Memory 页两
个记忆库（关于你 / 这个 Bot）与梦境（D1–D3）均已交付。本文档同时是实现记录、执行计划，
以及每一项的验收清单。

范围：`Bot` 设置面板的六项能力（头像、名称、电脑、工作区、权限、并行工作）与 Memory 页的
三个子页（关于你、这个 Bot、梦境）。

后续补齐项（token 口径、整理、时间回顾、撤销、来源与历史、搜索、长笔记、E2E、移动端对齐、
保留数配置）见 [`memory-and-dreams-gap-design.md`](./memory-and-dreams-gap-design.md)。

---

## 1. 已交付清单

| 能力         | 交付内容                                                                                                                               | 提交        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 专属工作区   | `Bot.workspacePath`、路径解析 base、上传白名单、运行期 cwd、web / 移动端输入、账号导出导入                                             | `0066f0faa` |
| 本机电脑指派 | `Bot.hostDeviceId`（外键 → `user_devices`，`ON DELETE SET NULL`）、`computers.devices` RPC、运行期显式设备路由、web 选择行、移动端只读 | `854f6f3ea` |
| 审批模式覆盖 | `Bot.approvalMode`（`ask` / `auto` / `never`，null = 跟随 Space）、唯一判定点读取、Auto 无模型退化 ask、web / 移动端选择器             | `6507ac184` |
| 并行后台工作 | `Bot.maxConcurrentHelpers`（默认 3，1–8）、bot 行锁内计数、超出拒绝而非排队、web / 移动端数字输入                                      | `f1be74164` |
| Memory 两库  | `Bot.useOwnMemory` / `Bot.useSharedMemory`（默认开）、prompt 裁剪、工具拒绝、预算按实际内容、web 子页、移动端开关                      | `7f3ee6c67` |
| 文案修正     | 描述字段标签改为 **Description**，跨 bot 用途移到说明行                                                                                | `6128228f8` |

### 1.1 迁移（全部为 additive，滚动发布安全）

| 迁移                                        | 内容                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `20261230130600_bot_workspace_path`         | `bots.workspacePath TEXT`                                                      |
| `20261230130700_bot_host_device`            | `bots.hostDeviceId TEXT` + 索引 + 外键                                         |
| `20261230130800_bot_approval_mode`          | `bots.approvalMode TEXT`                                                       |
| `20261230130900_bot_max_concurrent_helpers` | `bots.maxConcurrentHelpers INTEGER`                                            |
| `20261230131000_bot_memory_toggles`         | `bots.useOwnMemory`、`bots.useSharedMemory`（`BOOLEAN NOT NULL DEFAULT true`） |

无 drop、无重命名，不需要 `-- deferred` 迁移。

### 1.2 契约与 RPC 汇总

`packages/contracts/src/bots/bot.ts`：

- `BotSchema.workspacePath: string | null`（默认 null）
- `BotSchema.hostDevice: { id, name, platform, ownerUserId } | null`（默认 null）
- `BotSchema.approvalMode: "ask" | "auto" | "never" | null`（默认 null）
- `BotSchema.maxConcurrentHelpers: number | null`（默认 null，1–8）
- `BotSchema.useOwnMemory`、`useSharedMemory: boolean`（默认 true）
- `UpdateBotInput` 逐字段可选；`workspacePath` 走 `BotWorkspacePathSchema`（相对路径、拒绝
  `..` 与绝对路径），`approvalMode` / `maxConcurrentHelpers` 走枚举与范围校验

RPC：

- `bots.update`（全部字段）、`bots.setComputer`（team / dedicated）
- `computers.devices`（本人已配对电脑；受保护 RPC 穷举清单已覆盖）
- `memory.list` / `memory.budget` / `memory.update` / `memory.remove`（记忆库读写与预算）

---

## 2. 总原则（所有实现共同遵守）

1. **不做假开关**：没有契约与后端行为的能力不上 UI；UI 文案描述控件本身，用途放说明行。
2. **不给 run 排槽**：任何上限都是行为护栏（拒绝并说明），不是并发槽位；不引入全局并发
   上限、轮询等待或手工重试列。
3. **加列迁移**：只做 additive；旧版本代码在迁移后继续工作。
4. **单一判定点**：审批模式只在 `run-tool-gate` 读取；路径解析只在 `computer-support.ts`
   收口；记忆包含只在 `readAgentMemory` 收口。
5. **跨端一致**：web 与 Electron 共用 web UI；移动端能做就做，只读要写明原因。
6. **公开仓库**：设备名、会话内容、成对标识属用户数据，不进日志与公开 PR 文案。

---

## 3. 逐项设计（as-built）

### 3.1 名称与头像

现状即目标：`Bot.name`、`Bot.color`、`Bot.avatarSet`（`packages/db/prisma/schema.prisma`），
创建与更新走 `CreateBotInput` / `UpdateBotInput`；设置页可改名、选形状与颜色或上传图片，
bot 在会话里自改并带 Undo。无新增后端工作。

### 3.2 电脑：scope × placement

- `ComputerMode`（team / dedicated）表达存储与隔离范围，保持不动。
- 本机指派是独立维度：`Bot.hostDeviceId` 指向账号级 `UserDevice`，只影响 bot 的"用户电脑"
  工具（shell / 应用 / 屏幕），不替换 bot 自己的云端电脑。
- 保存时只接受 **bot 属主账号名下、未撤销** 的设备；属主由 `bot.userId` 推导，不存冗余列。
- 运行期：`RunSource.userComputerDeviceId` 显式传给 `UserDeviceGateway.connected(owner, id)`；
  显式设备不可用**绝不回退**到别的机器，工具返回明确错误；`user_computer_list` 只列绑定的
  那台。
- 多人 Space：`userComputerOwner` 只对 bot 属主发起的 run 返回属主，其他成员的 run 本就没有
  本机工具，绑定不会越权。
- 设备被撤销 / 删除：外键置空或 gateway 返回 null，表现为"离线"，由用户清除绑定。

### 3.3 专属工作区

- `Bot.workspacePath`（null = 默认：team 为 `bots/<botId>`，dedicated 为 home 根）。
- 解析收口在 `resolveBotWorkspacePath / Cwd / UploadPath / displayBotWorkspacePath`
  （`packages/adapters/src/computers/screens/computer-support.ts`），全部调用方（run 工具、
  routine watch、附件 materialize、API 文件路由、导出导入）传入 bot 设置。
- team 模式：相对路径锚到自定义目录，`shared/` 与显式根路径语义不变；上传白名单 = 自定义
  目录子树 + `shared/`。
- 写时校验（契约）拒绝绝对路径、`~`、`..`；解析时 `normalizeWorkspacePath` 再兜底。
- 建目录：provision 时 ensure（调用方传入设置）；保存后对运行中的电脑 best-effort 立即
  ensure，避免命令 cwd 不存在。
- 生效时机：命令 / 文件从下一个 run 起使用新目录；不迁移旧文件。

### 3.4 权限：审批模式覆盖

- `Bot.approvalMode ?? Space 模式`，唯一读取点
  `packages/adapters/src/runs/tools/run-tool-gate.ts`。
- Block 规则、强制审批、花费上限始终优先；`never` 也不能越过 Block。
- Auto 无审批模型时由 `planActionGate` 的 `checkerConfigured` 自然退化为 ask；设置页显示
  原因，不静默等同 never。
- 权限区块常驻（web 与移动端），零散开关（跨 Space 通信、管理其他 bot 等）仍只在改动后
  显示。

### 3.5 并行后台工作（"线程数"）

- 语义：该 bot 同时运行的后台 helper（subagent）上限；不是消息并行槽，不是多会话主线。
- 默认 `DEFAULT_MAX_CONCURRENT_HELPERS = 3`，范围 1–8
  （`packages/contracts/src/bots/bot.ts`）。
- 计数在 `startBackgroundHelper` 的 bot 行锁事务内完成（多进程正确）；达到上限时返回
  "已经有 N 个在跑，先结束本轮"，**不排队**。
- 消息在 run 进行中仍然 steering 进当前 run（`docs/run-execution.md`），与上限无关。

### 3.6 Memory 页：关于你 / 这个 Bot

- 两个记忆库都来自 `MemoryDocument`：`scope: "bot"`（这个 Bot）与 `scope: "user"`
  （关于你，Space 共享）。
- 每个库一个读取开关（`Bot.useOwnMemory` / `Bot.useSharedMemory`）：
  - 关闭后该库不进 prompt（`readAgentMemory` 的 `MemoryInclusion`）；
  - 对应记忆工具拒绝写入并说明原因（`remember` / `save_shared_memory`）；
  - `memory.budget` 按实际生效内容计算。
- 预算：bot 库沿用 `MEMORY_INDEX_PATH` 与 4 KB 写入上限；页面显示实际使用量。
- 语义记忆 provider（recall / reflect）不受两个开关影响，由 `memoryScope` 决定。

### 3.7 梦境（未实现）

**产品定义**：只在**夜间 / 空闲**时批量整理。整理只依据**用户自己的原话**，把记忆改写成更
准确、更短的版本；每次整理产出一条可回看的记录。它不是聊天消息，不打扰任何人。

#### 3.7.1 触发与调度

- 由 worker 的 reconciler housekeeping 每 30 秒评估一次（与其它清理共享领导权；候选查询
  走索引，不产生 run 排队），启动后的恢复交给 Graphile 备份 job（run-at = 整理超时 +
  余量）。
- 触发（与 Codync 对齐的"夜间 / 空闲"语义）：
  1. bot 的 `useOwnMemory` 或 `useSharedMemory` 至少一个为开；
  2. 该 bot 没有 `ACTIVE_RUN_STATUSES` 的 run（空闲）；
  3. bot 主 thread 有 `role = "user"` 且 `seq > 上次 completed 梦境的 sourceSeq` 的消息；
  4. 距该线程最后一条用户消息 ≥ 5 分钟（空闲），**或**积压 ≥ 8 条用户消息（立即整理）。
- 两次整理之间至少 5 分钟；夜晚不再单独触发（空闲已覆盖，没有新消息时也无事可做）。
- 幂等：job key 为 `memory-dream:<botId>:<YYYY-MM-DD>`；已有当天记录则跳过。
- 直接启动 + 备份：同一事务写 `MemoryDream(status = "queued")` 与备份 job（run-at = 整理 run
  的超时 + 余量）；提交后直接启动整理 run；成功删除备份 job，失败把 run-at 提前。进程崩溃
  时由备份 job 接手。
- 跳过原因可观测：`off` / `not-night` / `busy` / `no-new-messages` / `too-soon` /
  `already-dreamed`，写 `memory.dream.skipped` 日志（不含消息内容）。

#### 3.7.2 整理 run

- 触发值新增 `"memory_dream"`（`RUN_TRIGGERS`），加入非会话 / 后台触发集合：不参与
  steering，不出现在普通活动筛选里。
- 隐藏 thread（`Thread.helperBotId = bot.id`，每 dream 一条，随 bot 删除级联）；run 静默，
  **不向任何聊天发消息**。
- 输入：自上次 dream 以来的 `role = "user"` 消息（仅原话；不含 bot 回复、工具结果、外部
  内容），加上当前两个记忆库的文档。
- 工具：只暴露记忆写入（`remember`、`save_shared_memory`，按开关），不暴露其他工具；prompt
  明确"只写用户明确说过的事实，不推断、不编造；合并去重"。
- 审批：后台 run 无人可问。记忆写入在 dream run 中视为内部效果直接允许；Block 规则仍生效，
  被 Block 的动作记录为拒绝并结束本次 dream。
- 花费：使用 bot 当前模型与 thinking 设置，计入 Space 花费上限；超限时 dream 记为
  `failed`（`spending`），不重试到次日之外。
- 结束：写 `MemoryDream`（`summary`、`changedPaths`、`sourceSeq`、`startedAt`、
  `finishedAt`、`status`、`errorKind`），以 `runId` 唯一约束保证重放幂等。

#### 3.7.3 数据模型（新增）

`MemoryDream`：

| 列                                       | 类型                              | 说明                                |
| ---------------------------------------- | --------------------------------- | ----------------------------------- |
| `id`                                     | cuid                              |                                     |
| `spaceId`                                | FK Space                          | 级联删除                            |
| `botId`                                  | FK Bot                            | 级联删除                            |
| `threadId`                               | FK Thread?                        | 隐藏 thread，随 bot 级联            |
| `runId`                                  | FK Run? @unique                   | 整理 run；唯一约束做幂等            |
| `status`                                 | `queued` / `completed` / `failed` |                                     |
| `summary`                                | String?                           | 一句话摘要（展示用）                |
| `changedPaths`                           | String[]                          | 改动的记忆文档路径                  |
| `sourceSeq`                              | Int?                              | 已整理到的用户消息序号（watermark） |
| `errorKind`                              | String?                           | 失败类别（如 `spending`）           |
| `startedAt` / `finishedAt` / `createdAt` | DateTime                          |                                     |

索引：`[botId, status, createdAt]`。迁移为新增表，additive。

#### 3.7.4 RPC 与 UI（已实现）

- `memory.dreams`：`{ botId, limit?, cursor? }` → 记录列表（时间、摘要、改动路径、状态）。
- Memory 页第三个子页 **Dreams**（web + 移动端）：列表 + 空状态；两个记忆库都关时说明
  "记忆已关闭，梦境暂停"（不伪造开关）。列表项有可访问名称（时间 + 摘要），不显示原始 id。
- **Dream now**：手动触发一次整理（`memory.dreamNow`），跳过夜间窗口与每日冷却，但仍要求
  空闲、无进行中的梦境、距上次梦境 ≥10 分钟；说明行写明消耗一次模型调用，失败原因原地
  显示。
- 保留：每个 bot 最多保留最近 100 条记录；更早的记录与隐藏 thread 由定时清理删除（不影响
  记忆本身）。

---

## 4. 执行计划

### 4.1 已完成

| 阶段 | 内容                                              | 状态             |
| ---- | ------------------------------------------------- | ---------------- |
| P1   | 专属工作区（契约、迁移、解析、双端 UI、导出导入） | 完成 `0066f0faa` |
| P2   | 本机电脑指派（外键、RPC、运行期钉住、双端 UI）    | 完成 `854f6f3ea` |
| P3   | 审批模式覆盖（判定点、双端选择器、导出导入）      | 完成 `6507ac184` |
| P4   | 并行后台工作（默认 3、范围 1–8、双端输入）        | 完成 `f1be74164` |
| M1   | Memory 两库 + 开关（prompt 裁剪、工具拒绝、预算） | 完成 `7f3ee6c67` |
| M2   | 描述字段文案修正                                  | 完成 `6128228f8` |

### 4.2 剩余：梦境

拆三个 PR，按依赖串行；每个 PR 自带测试与文档，可独立回滚。

| PR            | 内容                                                                                                                          | 依赖   | 预估   | 完成定义（DoD）                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ | ------ | --------------------------------------------------------------------- |
| D1 存储与调度 | `RUN_TRIGGERS` 新触发值、`MemoryDream` 表与迁移、夜间 / 空闲候选查询、job key 幂等、直接启动 + 备份 job、跳过原因的日志与埋点 | 无     | 1 天   | 完成：`reconcileMemoryDreams` + 12 条单测（假时钟）                   |
| D2 整理 run   | 隐藏 thread 与受限工具集、prompt（仅用户原话 + 当前记忆）、审批与花费语义、结束写记录（runId 幂等）、失败分类                 | D1     | 1.5 天 | 完成：梦境内 `never` 语义、只提供记忆写入、完成 / 失败 / 备份三条路径 |
| D3 RPC 与 UI  | `memory.dreams` 契约与路由、Dreams 子页（web + 移动端）、空状态与暂停说明、保留清理                                           | D1、D2 | 1 天   | 完成：列表 / 空状态 / 暂停说明测试，不显示原始 id                     |

并行化：D1 完成后，D2 与 D3 的契约 / 组件壳可并行（D3 的联调依赖 D2 完成）。

---

## 5. 验收文档

### 5.1 通用验收（每一项都适用）

- [ ] 迁移为 additive，旧版本代码在迁移后仍能读写；无 drop / 重命名。
- [ ] 新契约字段对旧服务端缺省兼容（zod default），非法值返回 400 而不是 500。
- [ ] 设置保存后：web 与 Electron（同一 UI）立即反映；移动端在支持的项上一致，只读项已在
  文档说明原因。
- [ ] 无新增全局并发上限、轮询等待或手工重试列；新增等待只落在具体资源上。
- [ ] `pnpm format`、`pnpm checks`、`turbo run check` 全绿；新增字符串只在代码里。
- [ ] 用户数据（设备名、消息、标识）不出现在日志与公开 PR 文案。

### 5.2 逐项验收

**专属工作区**

- [ ] team 模式相对路径解析到自定义目录；`shared/` 与显式根路径语义不变。
- [ ] 上传白名单 = 自定义目录 + `shared/`；越界路径被拒绝。
- [ ] 保存后运行中的电脑立即存在该目录；命令 cwd 不再因目录缺失失败。
- [ ] 账号导出 / 导入往返保留设置；旧导出（无该字段）导入为默认。

**本机电脑指派**

- [ ] 保存只接受 bot 属主名下、未撤销的设备；其他账号的设备被拒绝。
- [ ] 绑定设备离线时工具返回明确错误，**不**回退到其他机器。
- [ ] 绑定时 `user_computer_list` 只列该设备。
- [ ] 其他成员的 run 没有本机工具（不因绑定获得权限）。
- [ ] 设备删除后绑定自动失效为"离线"。

**审批模式**

- [ ] `bot.approvalMode` 优先于 Space 模式；null 时完全跟随。
- [ ] Block 规则在 `never` 下仍然拒绝。
- [ ] Auto 无审批模型时退化为 ask，设置页显示原因。
- [ ] 账号导出 / 导入往返保留设置。

**并行后台工作**

- [ ] 默认 3；设置为 1 与 5 时分别在第 1 / 第 5 个 helper 处拒绝。
- [ ] 超限只返回说明，不排队、不阻塞主对话。
- [ ] 计数在事务内完成，多进程并发下不超发。
- [ ] 移动端与 web 输入语义一致（空 = 默认，1–8，越界原地报错）。

**Memory 两库**

- [ ] 关闭"这个 Bot"后 prompt 不含 bot 库；`remember` 拒绝写入并说明。
- [ ] 关闭"关于你"后 prompt 不含共享库；`save_shared_memory` 拒绝写入并说明。
- [ ] `memory.budget` 反映实际生效内容。
- [ ] 两个库都不影响语义记忆 provider 的 recall / reflect。

### 5.3 梦境验收（D1–D3）

**功能**

- [ ] 最后一条用户消息满 5 分钟后启动；此前跳过（`waiting`）。
- [ ] 积压 8 条用户消息时立即启动，不等空闲。
- [ ] bot 有活动 run 时跳过（`busy`），不排队等待。
- [ ] 没有新的用户消息时跳过（`no-new-messages`）；两次整理间隔 ≥5 分钟（`too-soon`）。
- [ ] 两个记忆库都关时跳过（`off`）。
- [ ] 整理只读取 `role = "user"` 的消息；bot 回复、工具结果、外部内容不进入输入。
- [ ] 完成后 `MemoryDream` 记录包含摘要、改动路径、**新增 / 移除的笔记行**与 `sourceSeq`；
  重放同一 run 不产生第二条记录。
- [ ] 整理 run 静默：任何聊天都不出现新消息。

**边界与安全**

- [ ] Block 规则拒绝的记忆写入被记录，dream 正常结束（`failed` 或 `completed` 带拒绝说明）。
- [ ] 超过 Space 花费上限时 dream 记为 `failed`（`spending`），不无限重试。
- [ ] 进程在整理中崩溃：备份 job 在超时后接手；成功后备份 job 被删除。
- [ ] 日志字段只含 bot / space / run 标识与跳过原因，不含消息内容。
- [ ] 记录保留上限生效（每 bot 100 条），更早的 thread 与记录被清理。

**UI**

- [ ] Memory 页第三个子页显示记录（时间、摘要、+ 新增行 / − 移除行、状态）与空状态。
- [ ] 两个记忆库关闭时显示"记忆已关闭，梦境暂停"。
- [ ] 列表项可访问名称完整，不显示原始 id；web 与移动端一致。
- [ ] **Dream now** 在空闲且距上次整理 ≥10 分钟时启动；忙碌、进行中或过近时返回 CONFLICT
  并原地显示原因；说明行写明消耗一次模型调用。

### 5.4 测试矩阵

| 层     | 覆盖                                                                      | 要求                                                                                                      |
| ------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 契约   | 字段默认值、范围 / 路径校验、旧服务端缺省                                 | `packages/contracts/src/bots/*.test.ts`                                                                   |
| 适配器 | 路径解析、设备钉住、审批判定、prompt 裁剪、工具拒绝、dream 调度与受限工具 | 单测 + `vi.useFakeTimers`；异步用 `deferred` / `flush` / `vi.waitFor`，不用零定时器 promise 或 sleep 循环 |
| API    | 保存校验、序列化、预算、dreams RPC                                        | 路由单测；postgres 测试在 CI                                                                              |
| Web    | Memory 子页、设备行、审批行、并行输入、Dreams 列表                        | 组件测试（受控组件需模拟父级确认）                                                                        |
| 移动   | 设置开关、输入行、只读项、共享顺序                                        | `apps/mobile/lib/**` 测试                                                                                 |
| E2E    | bot 设置全流程 + Memory 子页截图                                          | 交给 CI（不做本机桌面 e2e）                                                                               |

### 5.5 发布与回滚

- [ ] 五个已交付迁移 + 梦境迁移按时间顺序应用；无 `-- deferred`。
- [ ] 滚动发布期间旧 API / worker 可正常运行（additive 列、默认值）。
- [ ] 回滚代码不需要回滚数据；新列保持可空或有默认。
- [ ] `compat-shim` 无新增；如未来需要，标注 `compat-shim(after vX.Y.Z)`。

---

## 6. 风险与开放问题

- **本机执行边界**：设备不可用必须明确失败，绝不静默回退（安全边界）。
- **多人 Space**：设备名属用户数据；非属主看到绑定设备时只读展示并说明属主。
- **审批调松**：per-bot `never` 让该 bot 动作免审（Block 除外），实现 PR 带 Risk 段。
- **梦境成本与隐私**：整理消耗模型调用并读取用户消息；必须计入花费上限，日志不记录内容，
  只在属主本地夜间运行。
- **开放问题**：
  - 每个 bot 100 条记录的保留上限是否需要按 Space 配置？（手动整理已实现：`memory.dreamNow`。）

---

## 7. 附录

### 7.1 关键文件

- 契约：`packages/contracts/src/bots/bot.ts`、`bot-workspace.ts`、
  `bot-settings-layout.ts`、`packages/contracts/src/computers/computers-rpc.ts`
- 数据：`packages/db/prisma/schema.prisma`、`packages/db/src/bots/bot-repository.ts`
- 路径：`packages/adapters/src/computers/screens/computer-support.ts`
- 审批：`packages/adapters/src/runs/tools/run-tool-gate.ts`
- 并行：`packages/adapters/src/tasks/background-helpers.ts`
- 记忆：`packages/adapters/src/memory/memory-context.ts`、
  `packages/adapters/src/runs/tools/run-tools-memory.ts`
- Web：`apps/web/src/pages/shell/bots/bot-panel.tsx`、`bot-settings-sections.tsx`、
  `bot-memory-tabs.tsx`
- 移动：`apps/mobile/app/bot-settings.tsx`、`apps/mobile/components/bots/*`

### 7.2 验证命令

```bash
pnpm format
pnpm checks
pnpm exec turbo run check
pnpm exec vitest run packages/contracts/src/bots packages/adapters/src/memory \
  packages/adapters/src/runs/tools apps/web/src/pages/shell/bots apps/mobile/lib
```
