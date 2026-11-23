# 记忆与梦境：补齐设计与执行计划

状态：设计草案。本文档对照 Codync 的成熟实现（`/Users/yanluohao/develop/Codync`，参考
`docs/design/bot-memory.md`、`docs/features/context-and-memory.md`、`host/src/chat/memory/dream.rs`、
`apps/desktop/src/renderer/views/bots/MemoryView.tsx`），列出 Rakazo 当前记忆 / 梦境实现的缺口，
给出逐项设计、执行计划与验收清单。

范围：记忆写入规则与上限、整理（tidy）、时间回顾（review）、梦境撤销、记忆来源与历史、记忆
搜索、长笔记元数据、Dreams 的 E2E 与移动端对齐、翻译与保留数配置。

落地拆解、PR 切分与逐项验收见
[`memory-and-dreams-execution-plan.md`](./memory-and-dreams-execution-plan.md)。

---

## 1. 现状与差距

| 能力          | Codync                                             | Rakazo 现状                                                                                           | 差距                        |
| ------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------- |
| 记忆上限      | token 口径：共享 400、每 bot 1200、单行 150 tokens | 字节口径：`BOT_MEMORY_MAX_BYTES = 4 KB`（`packages/contracts/src/bots/bot-memory.ts:71`），单行无上限 | 中文被少算；无单行限制      |
| 一行一事实    | 写入时强制                                         | 提示词要求，`appendMemoryFact` 不去重多行                                                             | 可写多行、重复事实          |
| 90% 整理      | `MEMORY.md` 九成满时整理一次                       | 无                                                                                                    | 满后只能被拒绝写入          |
| 时间回顾      | 每天一次，把未来时态改写成过去                     | 无                                                                                                    | 过时事实不会更新            |
| 梦境撤销      | 记录带 `undone`，可回退                            | `MemoryDream` 无撤销状态                                                                              | 只能看不能退                |
| 记忆来源      | 每条显示作者（你 / bot / 梦境）与证据              | `MemoryRevision` 有 `sourceRunId` / `sourceThreadId`，UI 不展示                                       | 无来源、无历史              |
| 记忆搜索      | 子串搜索                                           | 无                                                                                                    | 文档一多只能翻              |
| 长笔记        | `description`、主题文件夹、每层 20 篇              | `MemoryDocument` 只有 path/content                                                                    | 无描述、无数量上限          |
| Dreams E2E    | —                                                  | 只有组件测试                                                                                          | 缺打开该屏的 web e2e 与截图 |
| 移动端 Dreams | 完整                                               | 只显示时间/摘要/状态                                                                                  | 缺 `+` / `−` 行与说明       |

已对齐（不在本文范围）：两库与开关、5 分钟空闲 / 8 条积压触发、Dream now、行级增删记录、
每 bot 100 条保留、梦境静默与失败分类。

---

## 2. 总原则

1. **不做假开关**：所有上限、整理、撤销都在写入 / 调度路径真实生效。
2. **加列迁移**：只做 additive；旧版本代码在迁移后继续工作。
3. **确定性测试**：调度用假时钟；异步用 `deferred` / `flush` / `vi.waitFor`，不写 sleep 循环。
4. **用户数据不上屏**：记录 id、run id、thread id 只留在状态里；屏幕显示时间、作者与摘要。
5. **一处口径**：token 计数、上限、每行限制只在共享模块里定义，写路径与 UI 读同一份。

---

## 3. 逐项设计

### G1 记忆 token 口径与一行一事实

**计数口径**：CJK 字符 1 token，其余字符每 4 个 1 token（向上取整）。新增共享模块
`packages/core/src/memory-tokens.ts`：

```ts
export function memoryTokenCount(text: string): number;
```

CJK 范围：Han `\u3400-\u4DBF`、`\u4E00-\u9FFF`，假名 `\u3040-\u30FF`，Hangul
`\uAC00-\uD7AF`，全角标点 `\uFF00-\uFFEF`。

**上限**（`packages/contracts/src/bots/bot-memory.ts`）：

- `MEMORY_TOKEN_CAPS = { shared: 400, bot: 1200 }`
- `MEMORY_LINE_TOKEN_CAP = 150`
- `MEMORY_NOTE_TOKEN_CAP = 2000`、`MEMORY_NOTES_PER_LAYER = 20`

**写路径强制**：

- `editMemory`（`packages/adapters/src/memory/memory-tools.ts`）：
  - 新事实包含换行 → 拒绝，提示 "One fact per line."（`old_text` 替换同理）；
  - 单行超过 150 tokens → 拒绝，并返回当前条目；
  - 整篇超过对应层上限（bot 1200 / shared 400）→ 拒绝，返回条目让 bot 合并。
- `save_shared_memory`（`run-tools-memory.ts` + `sharedMemorySaveError`）与 `memory.update`
  路由复用同一校验；UI 编辑超限时原地显示原因。
- 账号导入（`account-import`）与梦境写入遵守同一上限；导入超限时记录日志并跳过该篇，不失败
  整个导入。

**预算接口**：`MemoryPromptBudget` 增加（additive）：

- `limitTokens`、`usedTokens`
- `documents[].totalTokens`、`includedTokens`

保留现有字节字段（prompt 仍按字节裁剪上下文，token 只用于记忆上限与展示）。prompt 里的
usage 行改为 "X of 1200 tokens"。

**UI**：Memory 页两个库都显示 "已用 X / 上限 tokens"（`KnowledgeSection` 现只对 bot 库显示
字节预算）；超限时显示"整理后即可继续保存"。

**迁移影响**：已有内容可能超过新上限——不迁移数据；写入被拒绝时由 G2 整理腾出空间。

### G2 九成满整理（tidy）

- `MemoryDream.reason String`：`idle` / `batch` / `tidy` / `review` / `manual`。
- `Bot.memoryTidiedHash String?`：上次整理时 `MEMORY.md` 的哈希。
- 调度（`reconcileMemoryDreams`）：除空闲 / 积压外，当 bot 库 tokens ≥ 上限 90% 且哈希 ≠
  `memoryTidiedHash` 时，以 `reason: "tidy"` 启动，不要求新消息；每次 tidy 至少间隔 6 小时。
- 提示词：只做合并 / 去重 / 缩短，不新增事实；完成后在同一事务里写
  `Bot.memoryTidiedHash`。
- 没有可整理内容（一次运行没有改动任何行）也更新哈希，避免每轮重试。

### G3 每日时间回顾（review）

- 每天（bot 属主本地日）至多一次，`reason: "review"`；不要求新消息，记忆为空时跳过。
- 提示词加入当前本地日期，要求：**只有当日期已经过去**时，才把"将要去 X"改写成"X 月去了 X"；
  不确定的事实保持原样，不得推断。
- 记录与 tidy 同样落 `MemoryDream`；UI 显示 `review` 标签。

### G4 梦境撤销（undo）

- `MemoryDream.undoneAt DateTime?`。
- RPC `memory.undoDream({ dreamId })`：
  - 只允许该 bot **最近一条 completed 且未撤销**的梦境；
  - 事务内对涉及的 `MemoryDocument` 行 `FOR UPDATE`；若当前 revision 不是该梦境写入的
    revision → `CONFLICT`（"Memory changed since; nothing undone."）；
  - 逐篇把内容恢复为梦境写入前的 revision（通过 `memory.commit` 生成新 revision，
    `sourceKind: "undo"`），写 `undoneAt`；
  - 返回更新后的梦境记录。
- UI：Dreams 列表最新一条显示 **Undo**；不可撤销时按钮不出现（不是禁用假按钮）。

### G5 记忆来源与历史

- `MemoryRevision.sourceKind String?`：`user` / `bot` / `dream` / `import` / `undo`；旧行为 null
  视为 `user`。
  - 写入方：`memory.update` → `user`；`remember` → `bot`；梦境 → `dream`；账号导入 →
    `import`；撤销 → `undo`。
- RPC：
  - `memory.revisions({ documentId, limit?, cursor? })` → `{ id, revision, sourceKind, createdAt }[]`；
  - `memory.revision({ id })` → `{ revision, content, sourceKind, createdAt }`。
- UI（web）：每条记忆行加 **History**，侧栏按时间倒序列出 revision 与作者标签（You / This bot /
  Dreaming / Imported / Restored），可 **Restore**（`memory.restore({ documentId, revisionId,
  expectedRevision })`，以 `undo` 写入新 revision；客户端不选择来源）；不显示原始 id。
- 移动端：只读历史留到下一期，列表保持现状并在文档注明。

### G6 记忆搜索

- 客户端过滤：对 `memory.list` 已加载的文档按 path/content 做大小写不敏感子串匹配，显示命中
  片段；空结果显示 "No notes match"。
- 不新增 RPC：文档数量以十计、体积 ≤ 数十 KB；当单库文档超过 200 或列表分页后再评估服务端
  搜索（写入本文档的开放问题）。

### G7 长笔记元数据

- `MemoryDocument.description String?`：一句话描述，列表与梦境 prompt 的索引里显示。
- 每层最多 20 篇：`memory.commit` 新建路径时计数，超限拒绝并提示合并；覆盖已有路径不受限。
- 写入方：`memory.update` 与 `save_shared_memory` 接受 `description`（可选）；导出 / 导入往返。
- UI：笔记行显示路经 + 描述；编辑器增加描述输入。

### Q1 Dreams 的 Web E2E 与截图

- 新增 `apps/web/e2e/bots/memory-dreams.spec.ts`：打开 bot → **Memory** → **Dreams**，断言
  空状态、Dream now、`+` / `−` 行、说明文案；用现有 helpers 产出截图，交 CI。
- 不在本机跑 e2e（AGENTS.md），push 后读 CI 截图。

### Q2 移动端 Dreams 对齐

- 每条梦境最多显示 2 条 `+`（success 色）与 2 条 `−`（destructive 色），超出以 "…" 收口；
- 时间用相对日期（今天 / 昨天 / 日期），footer 说明 "Dreaming uses one model call."；
- 保持 5 条预览，完整列表在 web。

### Q3 翻译

- 新增文案只进代码；按仓库流程由 main 的 "Update translation catalogs" 工作流或独立翻译 PR
  补 `messages.po`。本文档不产生翻译改动。

### Q4 梦境保留数按 Space 配置

- `Space.dreamRetention Int?`（默认 100，范围 20–500）。放在 Space 上而不是
  `SpaceMemoryConfig`：记忆提供者是可选的第三方连接，梦境保留数不该因为没连提供者就改不了。
- 调度清理（`pruneMemoryDreams`）按 Space 读取该值；设置入口与 UI 放到记忆设置页；
- 迁移：Space 加列（additive），旧行（null）按 100。

---

## 4. 数据模型与契约汇总

| 变更                         | 类型                              |
| ---------------------------- | --------------------------------- |
| `MemoryDream.reason`         | 新列（可空，旧行 null 视为 idle） |
| `MemoryDream.undoneAt`       | 新列（可空）                      |
| `Bot.memoryTidiedHash`       | 新列（可空）                      |
| `MemoryRevision.sourceKind`  | 新列（可空，null = user）         |
| `MemoryDocument.description` | 新列（可空）                      |
| `Space.dreamRetention`       | 新列（可空，默认 100）            |

RPC：`memory.undoDream`、`memory.revisions`、`memory.revision`、`memory.restore`、
`memory.dreamRetention`、`memory.setDreamRetention`；`MemoryPromptBudget` 增加 token 字段
（additive）。

迁移全部为加列，与滚动发布兼容，无 `-- deferred`。

---

## 5. 执行计划

| 阶段 | 内容                                                               | 依赖 | 预估   | DoD                                                          |
| ---- | ------------------------------------------------------------------ | ---- | ------ | ------------------------------------------------------------ |
| P0   | Q1 E2E + 截图、Q2 移动端 `+`/`−` 行与说明                          | 无   | 0.5 天 | CI 截图可见；移动端测试更新                                  |
| P1   | G1 token 计数、上限、单行规则（contracts/core/adapters/API/UI）    | 无   | 1.5 天 | 写路径与 UI 同口径；超限错误可读；单测覆盖 CJK / 拉丁 / 混合 |
| P2   | G2 tidy + G3 review（`reason`、`memoryTidiedHash`、调度与 prompt） | P1   | 1.5 天 | 假时钟覆盖 90% / 每日一次 / 无改动不重试；日志无内容         |
| P3   | G4 undo + G5 来源与历史（`undoneAt`、`sourceKind`、RPC、侧栏）     | P1   | 1.5 天 | 撤销冲突返回 CONFLICT；历史不显示 id；恢复生成新 revision    |
| P4   | G6 搜索 + G7 长笔记元数据（description、每层 20 篇）               | P1   | 1 天   | 搜索空态；超限拒绝；导出导入往返                             |
| P5   | Q4 保留数配置                                                      | P2   | 0.5 天 | 配置生效；旧行默认 100                                       |

顺序建议：P0 → P1 → P2 → P3 → P4 → P5。P2 与 P3 可在 P1 后并行。

---

## 6. 验收文档

### 6.1 通用

- [ ] 所有迁移为 additive；旧代码在迁移后能读写。
- [ ] 新契约字段对旧服务端缺省兼容，非法值返回 400。
- [ ] `pnpm format`、`pnpm checks`、`turbo run check` 全绿。
- [ ] 日志只含 bot / space / run 标识与跳过原因，不含消息内容。

### 6.2 逐项

**G1 token 口径**

- [ ] 纯中文 400 字 = 400 tokens；纯拉丁 400 字 = 100 tokens；混合按规则累加。
- [ ] 单行 151 tokens 被拒绝并说明；多行事实被拒绝。
- [ ] bot 库 1200、共享库 400 超限被拒绝，返回当前条目。
- [ ] UI 显示 token 用量；prompt usage 行一致。

**G2 tidy**

- [ ] 90% 满时启动 tidy；hash 未变不重复启动；6 小时冷却生效。
- [ ] tidy 只合并 / 删除，不新增事实；完成后 hash 更新。

**G3 review**

- [ ] 每天至多一次；无新消息也可运行；记忆为空跳过。
- [ ] 只有日期已过去的未来时态被改写；不确定内容保持原样。

**G4 undo**

- [ ] 最新 completed 梦境可撤销，逐篇恢复到写入前内容并生成 `undo` revision。
- [ ] 非最新、已撤销或记忆已变化时返回 CONFLICT；UI 不显示假按钮。

**G5 来源与历史**

- [ ] 四种 writer 的 `sourceKind` 正确；旧行显示 You。
- [ ] 历史侧栏按时间倒序；Restore 生成新 revision 且不显示原始 id。

**G6 搜索**

- [ ] 大小写不敏感；路径与内容都命中；空结果有说明。

**G7 长笔记**

- [ ] 描述显示在列表与梦境索引；每层第 21 篇被拒绝；导出导入保留描述。

**Q1/Q2**

- [ ] E2E 在 CI 通过并产出截图；移动端显示 `+` / `−` 各至多 2 行与相对日期。

### 6.3 测试矩阵

| 层        | 覆盖                                                        |
| --------- | ----------------------------------------------------------- |
| contracts | token 计数、预算字段、描述与保留数字段                      |
| adapters  | 写路径上限、tidy/review 调度（假时钟）、undo 冲突、来源标签 |
| API       | memory.update / undoDream / revisions 的授权与错误          |
| web       | 搜索、历史侧栏、Undo、token 用量                            |
| mobile    | Dreams `+`/`−` 行、说明、相对日期                           |
| e2e       | Memory → Dreams 打开、空态、Dream now、记录行（CI）         |

### 6.4 发布与回滚

- [ ] 六个加列迁移按序应用；无 drop。
- [ ] 回滚代码不需要回滚数据；旧行 null 有明确的默认语义。
- [ ] 新上限对存量超限内容：只拒绝写入，由 tidy 腾空间，不丢数据。

---

## 7. 风险与开放问题

- **口径变化**：从字节切到 token 会让既有 bot 的"可用空间"变化；超限时只拒绝写入并提示
  整理，不静默截断。
- **撤销与并发**：撤销只允许最新梦境且要求 revision 未变；否则 CONFLICT。
- **搜索规模**：客户端搜索适用于当前文档量；超过 200 篇的 Space 需要服务端搜索（开放问题）。
- **开放问题**：tidy 的 6 小时间隔是否需要按 Space 可配；移动端历史侧栏的排期。

---

## 8. 附录

关键文件：

- 上限与 token：`packages/contracts/src/bots/bot-memory.ts`、新增
  `packages/core/src/memory-tokens.ts`
- 写入：`packages/adapters/src/memory/memory-tools.ts`、
  `packages/adapters/src/runs/tools/run-tools-memory.ts`、`packages/memory/src/index.ts`
- 预算 / 提示词：`packages/adapters/src/memory/memory-context.prompt.ts`
- 梦境：`packages/adapters/src/memory/memory-dreams.ts`、`memory-dream.prompt.ts`
- UI：`apps/web/src/pages/space/KnowledgeSection.tsx`、
  `apps/web/src/pages/shell/bots/bot-memory-tabs.tsx`、`apps/mobile/components/bots/bot-dreams-section.tsx`
- E2E：`apps/web/e2e/bots/`

验证命令：

```bash
pnpm format
pnpm checks
pnpm exec turbo run check
pnpm exec vitest run packages/contracts/src/bots packages/adapters/src/memory \
  packages/adapters/src/runs/tools apps/web/src/pages/shell/bots apps/mobile/lib
```
