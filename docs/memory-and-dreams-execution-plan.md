# 记忆与梦境：落地执行计划

输入：[`memory-and-dreams-gap-design.md`](./memory-and-dreams-gap-design.md)。本文档把设计拆成
可独立发布的 PR（P0–P5），每个任务给出落点文件、测试与**验收标准**；同时定义跨阶段门禁、
验收矩阵与发布 / 回滚清单。

状态：P0–P5 已完成。开始任何任务前，先满足本文档的
「第 0 节 先决条件」。

---

## 0. 先决条件（每次开工前）

- [ ] 工作区里未提交的 `apps/web/src/pages/shell/bots/instruction-settings.tsx`（`ToggleGroup`
  未补 mock）先落地或回退，否则 `apps/web/src/pages/shell/bots` 套件是红的，CI 无法判断
  本次改动是否引入回归。
- [ ] 本地 dev（`screen -S rakazo-dev`）可用；数据库迁移在启动时应用。
- [ ] 基线：`pnpm checks` 151/151、`pnpm exec turbo run check` 24/24。

---

## 1. 执行总览

| 阶段 | PR   | 内容                                                        | 依赖 | 预估   | 可并行        |
| ---- | ---- | ----------------------------------------------------------- | ---- | ------ | ------------- |
| P0   | PR-1 | Dreams 的 Web E2E + 截图；移动端 `+` / `−` 行与说明         | 无   | 0.5 天 | 与 P1 并行    |
| P1   | PR-2 | 记忆 token 口径、单行上限、一行一事实（写路径 + 预算 + UI） | 无   | 1.5 天 | 与 P0 并行    |
| P2   | PR-3 | 90% 整理（tidy）+ 每日时间回顾（review）                    | P1   | 1.5 天 | 与 P3 并行    |
| P3   | PR-4 | 梦境撤销 + 记忆来源与历史                                   | P1   | 1.5 天 | 与 P2 并行    |
| P4   | PR-5 | 记忆搜索 + 长笔记元数据（description、每层 20 篇）          | P1   | 1.0 天 | 与 P2/P3 并行 |
| P5   | PR-6 | 每 Space 梦境保留数配置                                     | P2   | 0.5 天 | 最后          |

顺序建议：P0 与 P1 同批开工 → P2/P3/P4 并行 → P5 收口。每个 PR 自带测试与文档，可独立回滚。

---

## 2. 工作分解（WBS）

### P0 · Dreams 的 E2E 与移动端对齐（PR-1）

**目标**：把已交付的 Dreams 屏纳入 CI 可视验证，并让移动端与 web 呈现一致。

| ID    | 任务                                                                                                                                             | 落点                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| P0-T1 | 新增 E2E：打开 bot → Memory → Dreams，断言空态、Dream now、`+` / `−` 行、说明文案；产出截图                                                      | `apps/web/e2e/bots/memory-dreams.spec.ts`（新），复用 `openBotMemory` |
| P0-T2 | 移动端每条梦境显示至多 2 条 `+`（success）与 2 条 `−`（destructive），超出以 `…` 收口；时间改相对日期；footer 写 "Dreaming uses one model call." | `apps/mobile/components/bots/bot-dreams-section.tsx`                  |
| P0-T3 | 更新移动端测试：行内容、相对日期、footer 文案                                                                                                    | `apps/mobile/lib/voice/bot-settings-voice.test.tsx`                   |
| P0-T4 | 文档：在 `docs/memory.md` 补 Dream now 与 `+` / `−` 的说明                                                                                       | `docs/memory.md`                                                      |

**验收标准**

- [ ] E2E 在 CI 通过，并产出能看清 Dreams 行的截图（PR 描述里引用）。
- [ ] 移动端：有 `added` / `archived` 时各最多 2 行，颜色与 web 语义一致；无数据时空态不回归。
- [ ] 移动端测试覆盖：`+` / `−` 渲染、相对日期、footer 文案。
- [ ] 本机不跑桌面 / web e2e（交给 CI）。

**回滚**：纯 UI / 测试改动，revert 单个 PR 即可。

---

### P1 · 记忆 token 口径与一行一事实（PR-2）

**目标**：记忆上限从字节切到 token，写路径强制一行一事实与单行上限。

| ID    | 任务                                                                                                                                                     | 落点                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| P1-T1 | 新增 `memoryTokenCount(text)`（CJK 1/字，其余 1/4，向上取整）与单测（纯中文 / 纯拉丁 / 混合 / 全角）                                                     | `packages/core/src/memory-tokens.ts`（新）+ 测试                                                     |
| P1-T2 | 上限常量：`MEMORY_TOKEN_CAPS = { shared: 400, bot: 1200 }`、`MEMORY_LINE_TOKEN_CAP = 150`、`MEMORY_NOTE_TOKEN_CAP = 2000`、`MEMORY_NOTES_PER_LAYER = 20` | `packages/contracts/src/bots/bot-memory.ts`                                                          |
| P1-T3 | `editMemory` / `appendMemoryFact`：拒绝多行事实、单行超 150 tokens、整篇超上限；错误信息带当前条目                                                       | `packages/adapters/src/memory/memory-tools.ts` + 测试                                                |
| P1-T4 | 共享写入校验改用 token 口径（替换 `MAX_SHARED_MEMORY_CHARS`）                                                                                            | `packages/adapters/src/tools/builtin.tool-definition.ts`、`run-tools-memory.ts`                      |
| P1-T5 | `memory.update` 路由与账号导入走同一校验；导入超限记日志并跳过该篇                                                                                       | `apps/api/src/routes/memory.ts`、`apps/api/src/account/account-import.ts`                            |
| P1-T6 | 预算接口 additive 字段：`limitTokens` / `usedTokens` / `documents[].totalTokens` / `includedTokens`；prompt usage 行改 token                             | `packages/contracts/src/bots/bot-memory.ts`、`packages/adapters/src/memory/memory-context.prompt.ts` |
| P1-T7 | UI 两个记忆库都显示 "已用 X / 上限 tokens"；超限提示"整理后即可保存"                                                                                     | `apps/web/src/pages/space/KnowledgeSection.tsx`、`bot-memory-tabs.tsx`                               |
| P1-T8 | 文档：更新 `docs/memory.md` 的上限说明                                                                                                                   | `docs/memory.md`                                                                                     |

**验收标准**

- [ ] 纯中文 400 字 = 400 tokens；纯拉丁 400 字 = 100 tokens；混合按规则累加（单测）。
- [ ] 多行事实被拒绝，提示 "One fact per line."；单行 151 tokens 被拒绝并返回当前条目。
- [ ] bot 库 1200 / 共享库 400 超限被拒绝；错误信息可读。
- [ ] `memory.budget` 同时返回字节与 token（旧客户端不回归）；UI 显示 token 用量。
- [ ] 账号导入遇到超限笔记：跳过该篇、记录日志、其余导入成功。
- [ ] 既有记忆测试（`memory-context.test.ts`、`run-tools-memory.test.ts`）全绿。

**风险**：口径变化让存量 bot 可用空间变化；只拒绝写入，由 P2 的 tidy 腾空间，不截断。

**回滚**：token 字段是 additive；回滚代码后旧字节预算继续工作。

---

### P2 · 90% 整理 + 每日时间回顾（PR-3）

**目标**：记忆接近上限时自动整理；每天把已过期的未来时态改写为过去。

| ID    | 任务                                                                                                                 | 落点                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| P2-T1 | `MemoryDream.reason`（`idle` / `batch` / `tidy` / `review` / `manual`，可空，旧行视为 idle）；`Bot.memoryTidiedHash` | `packages/db/prisma/schema.prisma` + 迁移             |
| P2-T2 | 调度：bot 库 ≥ 90% 且哈希变化 → `reason: "tidy"`（6 小时冷却，不要求新消息）；本地日首条 review → `reason: "review"` | `packages/adapters/src/memory/memory-dreams.ts`       |
| P2-T3 | 提示词：tidy 只合并 / 删除，不新增；review 注入本地日期，只改写日期已过去的未来时态                                  | `packages/adapters/src/memory/memory-dream.prompt.ts` |
| P2-T4 | 完成后在同一事务写 `memoryTidiedHash`；无改动也更新哈希，避免每轮重试                                                | `recordMemoryDream` / `startMemoryDream`              |
| P2-T5 | UI：Dreams 行显示 reason 标签（Tidy / Review / Manual）                                                              | `bot-memory-tabs.tsx`、`bot-dreams-section.tsx`       |
| P2-T6 | 测试（假时钟）：90% 触发、哈希未变不触发、6 小时冷却、每日一次 review、无改动不重试                                  | `memory-dreams.test.ts`                               |

**验收标准**

- [x] 90% 满时启动一次 tidy；内容未变不重复启动；6 小时内不重复。
- [x] 每天至多一次 review；记忆为空跳过；无新消息也可运行。
- [x] tidy 运行后记忆行数 / token 下降，且没有新增事实（测试断言）。
- [x] review 只改写日期已过去的句子；不确定内容保持原样。
- [x] 日志字段只含 bot / space / reason，不含消息内容。

**回滚**：新增列可空；回滚代码后旧调度忽略新列。

---

### P3 · 梦境撤销 + 记忆来源与历史（PR-4）

**目标**：梦境可回退；每条记忆显示来源并可看历史 / 恢复。

| ID    | 任务                                                                                                                                                          | 落点                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| P3-T1 | `MemoryDream.undoneAt`；`MemoryRevision.sourceKind`（`user` / `bot` / `dream` / `import` / `undo`，null=user）                                                | `schema.prisma` + 迁移                                                                          |
| P3-T2 | 写入方标记 sourceKind：`memory.update` → user；`remember` → bot；梦境 → dream；导入 → import；撤销 → undo                                                     | `apps/api/src/routes/memory.ts`、`run-tools-memory.ts`、`memory-dreams.ts`、`account-import.ts` |
| P3-T3 | `memory.undoDream({ dreamId })`：仅最新 completed 且未撤销；文档行 `FOR UPDATE`；当前 revision ≠ 梦境写入 revision → `CONFLICT`；逐篇恢复并写 `undo` revision | `apps/api/src/routes/memory.ts`、`packages/adapters/src/memory/*`                               |
| P3-T4 | `memory.revisions` / `memory.revision` RPC（列表只给元数据，不返回原始 id 到屏幕）                                                                            | `packages/contracts/src/bots/bots-rpc.ts`、路由                                                 |
| P3-T5 | Web：每行 **History** 侧栏（作者标签 + 相对时间 + Restore）；Dreams 最新一条显示 **Undo**                                                                     | `KnowledgeSection.tsx`、`bot-memory-tabs.tsx`                                                   |
| P3-T6 | 测试：撤销冲突、恢复生成新 revision、来源标签；受保护 RPC 穷举清单补新 RPC                                                                                    | 各包测试、`packages/testkit/src/product/authorization.test.ts`                                  |

**验收标准**

- [x] 最新 completed 梦境可撤销，逐篇恢复到写入前内容，并生成 `undo` revision。
- [x] 非最新、已撤销或记忆已变化时返回 `CONFLICT`，UI 不显示假按钮。
- [x] 历史侧栏按时间倒序；`sourceKind` 四种写入方正确；旧行显示 "You"。
- [x] Restore 生成新 revision，`expectedRevision` 冲突返回 `CONFLICT`。
- [x] 新 RPC 在受保护穷举测试中覆盖。

**回滚**：列可空；撤销接口回滚后历史仍可读。

---

### P4 · 记忆搜索 + 长笔记元数据（PR-5）

**目标**：记忆页可搜索；长笔记有描述与每层数量上限。

| ID    | 任务                                                                                  | 落点                                              |
| ----- | ------------------------------------------------------------------------------------- | ------------------------------------------------- |
| P4-T1 | 客户端子串搜索（path / content，大小写不敏感，显示片段，空态 "No notes match"）       | `KnowledgeSection.tsx`                            |
| P4-T2 | `MemoryDocument.description`（可空）；`memory.update` / `save_shared_memory` 接受描述 | `schema.prisma` + 迁移、契约、路由、工具          |
| P4-T3 | 每层 20 篇：`memory.commit` 新建路径时计数，超限拒绝并提示合并；覆盖已有路径不受限    | `packages/memory/src/index.ts`                    |
| P4-T4 | 梦境 prompt 的索引带描述；导出 / 导入往返保留描述                                     | `memory-dream.prompt.ts`、`account-export/import` |
| P4-T5 | UI：笔记行显示 path + description；编辑器加描述输入                                   | `KnowledgeSection.tsx`                            |

**验收标准**

- [x] 搜索大小写不敏感，路径与内容都命中；空结果显示说明。
- [x] 第 21 篇新建被拒绝；覆盖已有路径不受限。
- [x] 描述在列表与梦境索引显示；导出导入往返保留。
- [x] 既有记忆列表 / 预算测试全绿。

**回滚**：`description` 可空；回滚后列表忽略该列。

---

### P5 · 每 Space 梦境保留数（PR-6）

| ID    | 任务                                            | 落点                                             |
| ----- | ----------------------------------------------- | ------------------------------------------------ |
| P5-T1 | `Space.dreamRetention Int?`（默认 100，20–500） | `schema.prisma` + 迁移、契约                     |
| P5-T2 | `pruneMemoryDreams` 读取该值；配置缺失按 100    | `memory-dreams.ts`、`reconcileMemoryDreams` 注入 |
| P5-T3 | 记忆设置页暴露输入（web；移动端只读）           | 记忆设置组件                                     |
| P5-T4 | 测试：自定义保留数生效；旧行默认 100            | 适配器 / API 测试                                |

**验收标准**

- [x] 设置为 20 / 500 时分别保留对应条数；未设置时 100。
- [x] 旧配置行（无该列）默认 100，不报错。
- [x] 清理同时删除隐藏 thread，记忆本身不受影响。

---

## 3. 跨阶段门禁（每个 PR 合入前）

- [ ] `pnpm format`（Biome）无改动。
- [ ] `pnpm checks` 全绿（151 项基线）。
- [ ] `pnpm exec turbo run check` 24/24。
- [ ] 受影响套件：`pnpm exec vitest run <本 PR 目录>` 全绿。
- [ ] 迁移按时间顺序新增，additive；无 `-- deferred`。
- [ ] UI 变更：web 测试覆盖该屏；PR 描述引用 CI 截图（无截图时说明原因）。
- [ ] PR 描述含 `## What` / `## Why` / `## Changes`，有风险时加 `## Risk`，结尾 `## Tested`。
- [ ] 新增 UI 字符串只在代码里；不跑 `intl:extract`、不改 `messages.po`。

---

## 4. 验收矩阵（需求 → 测试）

| 需求                 | 测试层               | 关键文件                                        |
| -------------------- | -------------------- | ----------------------------------------------- |
| token 计数与单行上限 | contracts + adapters | `memory-tokens.test.ts`、`memory-tools.test.ts` |
| 预算 token 字段      | contracts + web      | `bot-memory` 测试、`KnowledgeSection` 测试      |
| tidy / review 调度   | adapters（假时钟）   | `memory-dreams.test.ts`                         |
| 撤销冲突 / 恢复      | API + adapters       | `routes/memory` 测试、`memory-dreams.test.ts`   |
| 来源与历史           | API + web            | `routes/memory` 测试、`KnowledgeSection` 测试   |
| 搜索 / 描述 / 20 篇  | web + memory 包      | `KnowledgeSection` 测试、`packages/memory` 测试 |
| 保留数               | adapters + API       | `memory-dreams.test.ts`                         |
| Dreams 屏            | e2e（CI）            | `apps/web/e2e/bots/memory-dreams.spec.ts`       |
| 移动端行             | mobile               | `bot-settings-voice.test.tsx`                   |

---

## 5. 发布与回滚

- [ ] 六个加列迁移（P2/P3/P4/P5 各一个）按序应用；无 drop、无重命名。
- [ ] 滚动发布：旧 API / worker 在迁移后继续工作（新列可空或有默认）。
- [ ] 回滚代码不需要回滚数据；新列保持可空。
- [ ] 口径切换（P1）与 tidy（P2）同批发布，避免存量超限长期无法写入。

---

## 6. 任务看板

- [x] 0 先决条件
- [x] P0-T1 … P0-T4
- [ ] P1-T1 … P1-T8
- [ ] P2-T1 … P2-T6
- [ ] P3-T1 … P3-T6
- [ ] P4-T1 … P4-T5
- [ ] P5-T1 … P5-T4

每个任务完成时勾选，并在 PR 描述里链接对应用例；阶段完成的标准是本文档「验收标准」全部勾选。

---

## 7. 风险与决策记录

- **口径变化**：token 上限小于原 4 KB 字节时，存量 bot 会先遇到拒绝；由 tidy 腾空间，不静默
  截断。P1 与 P2 同批发布。
- **撤销并发**：只允许最新梦境且 revision 未变；否则 CONFLICT，避免覆盖用户后续修改。
- **搜索规模**：客户端搜索适用于当前文档量；单库超过 200 篇时另开服务端搜索。
- **成本**：tidy / review 各消耗一次模型调用；沿用花费上限与失败分类，不新增队列。
- **开放问题**：tidy 的 6 小时间隔是否按 Space 可配；移动端历史侧栏排期。
