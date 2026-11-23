# Agent 对话设置详细设计：压缩策略与单轮工具上限

状态：设计评审中。本文只定义产品行为、契约、运行时边界、迁移和验收标准；评审通过前不继续实现。

读者：产品、后端、Agent 运行时、Web、移动端和测试维护者。

## 0. 结论摘要

本次只做两个设置，但都按“可上线能力”设计，而不是两个孤立的输入框：

1. **对话压缩策略**：每个 Bot 可以选择自动、提早、接近上限、指定 token 阈值。触发点
   在 turn 完成之后，使用运行时实际观察到的上下文 token 数，而不是猜测消息条数。
2. **单轮工具调用上限**：每个 Bot 可以覆盖部署级的
   `MAX_TOOL_CALLS_PER_TURN`。留空表示沿用部署默认；达到上限时软停止，不把 run 标为
   失败，也不取消已开始的工具调用。

关键决策：

- 压缩设置存两个字段：`conversationCompactionMode` 和
  `conversationCompactionTokens`。前者决定行为，后者只在 `custom` 时生效。
- 运行时通过新增的 per-request `onContextObserved` 回调取得
  `RuntimeContextDecision.estimatedInputTokens`，把它保存在 `RunContext`，不额外查询
  `usage_records`，也不重新实现 token 估算。
- `automatic` 保持当前消息计数行为，升级不改变已有 Bot 的压缩时机。
- `earlier` 使用模型窗口的 50%，`near_limit` 使用 80%，`custom` 使用用户阈值并限制在
  模型窗口的 90% 以内。
- 只有至少 5 条新的未压缩消息时才允许 token 模式再次触发，避免“摘要本身仍然超过阈值”
  造成每轮压缩。
- 工具上限按 turn 计数，按 run 隔离；后台 helper 的 run 也各自计数。
- 所有数据库变更都是 additive，旧版本代码在迁移后继续工作。

## 1. 现状：代码事实

设计必须先承认现有链路，否则很容易做出一个“看起来能用、实际不会触发”的开关。

### 1.1 现有压缩链路

`packages/adapters/src/runs/lifecycle/run-complete.ts`

- `completeRun` 在 run 结束后调用 `enqueueHistoryCompaction(ctx)`。
- 当前使用 `shouldEnqueueCompaction(nextMessageSeq, historyCompactedUpToSeq, 50, 50)`。
- 只有 `contextStrategy === "current"` 时才入队。这是现有行为，本次不改。
- 入队 job 通过 `historyCompactJob(threadId, run.userId)`，job key 是
  `history.compact:<threadId>`，同一 thread 并发入队会替换而不是堆积。

`packages/adapters/src/runtime/context/history-compaction.ts`

- `HISTORY_WINDOW_SIZE = 50`：压缩后 prompt 保留最近 50 条消息。
- `COMPACTION_BATCH_SIZE = 50`：每次总结最早 50 条未压缩消息。
- `LEGACY_HISTORY_WINDOW_SIZE = 200`：没有语义记忆或未压缩时的旧窗口。
- `shouldEnqueueCompaction` 用消息条数判断是否达到 `window + batch`。
- `compactHistory` 读取 thread、bot、消息块，调用运行时生成摘要，写回
  `historyCompactedUpToSeq`、`historyCompactionSummary` 和
  `historyCompactionGeneration`，并记录 `operationKind: "compaction"` 的用量。
- 摘要失败时游标不前进，job 重试；摘要超过 `MAX_COMPACTED_SUMMARY_CHARS = 20_000`
  时设置 `historyCompactionRetryAfterSeq`，避免同一批永远失败。
- 成功后如果仍有 backlog，会继续入队，直到未压缩消息少于 `window + batch`。

`packages/adapters/src/runs/assembly/run-assembly-history.ts`

- `selectCompactedHistory` 只在摘要存在、游标存在、游标后的消息连续时使用摘要。
- `historyWindowSize` 决定 prompt 里保留多少条消息：语义记忆开启、已压缩且 recall 成功
  时用 50，否则用 200。
- 消息不连续、摘要为空或摘要超长时回退到完整窗口，避免静默制造历史缺口。

`packages/adapters/src/runs/assembly/run-assembly-records.ts`

- 一次最多加载 200 条最近消息。自定义窗口不能超过这个上限，否则 prompt 组装层拿不到
  足够消息。

### 1.2 上下文 token 估算

`packages/adapters/src/runtime/context/context-selection.ts`

- `estimateTextTokens` 是 provider-neutral 的字符权重估算，已针对英文、代码、JSON、
  ID、非拉丁文字和 emoji 校准。
- `estimateContextTokens` 在文本估算上加入消息 framing 和图片估算。
- `RuntimeContextDecision.estimatedInputTokens` 是每次模型调用实际选择的上下文估算，
  已经包含系统提示、工具定义、历史消息和当前轮内容。
- `createRuntimeContextPolicy` 在每次模型调用前做选择；`onUsage` 时把
  `decision` 交给 `PiAgentRuntimeOptions.onContextDecision`。

这意味着：**不要新写 token 估算器**。用运行时已经算出的
`estimatedInputTokens`，否则会和真实 prompt 选择不一致。

### 1.3 工具预算现状

`packages/adapters/src/runtime/pi/tools/pi-runtime-tools.ts`

- `maxToolCallsPerTurn()` 读取部署环境变量 `MAX_TOOL_CALLS_PER_TURN`。
- 未设置、空字符串、0、负数、非数字都视为不限。
- `toolCallBudgetFor(runId, savedCount)` 用进程内 Map 保存每个 run 的预算，支持
  pause/resume 时从 checkpoint 恢复计数。
- `beginToolCall` 在调用前计数；超过上限时设置 `exceeded`，并行批次允许完成，随后
  `abortTurn`。
- `toolCallBudgetExceededMessage(limit)` 给出可继续的提示。

`packages/adapters/src/runtime/pi/pi-runtime.ts`

- 每次 run 开始时调用 `toolCallBudgetFor(request.runId, saved.toolCallCount)`。
- 当前没有 per-run limit，只有部署级环境变量。

### 1.4 设置 UI 现状

Web / Electron：

- `apps/web/src/pages/shell/bots/bot-panel.tsx` 是 Bot 设置面板。
- `apps/web/src/pages/shell/bots/bot-settings-sections.tsx` 已有 `ParallelWorkRow`
  等设置行。
- 模型、思考级别、电脑、语音通过 `advancedValues` 快照保存；审批、并行工作等通过
  `enqueueSave` 立即保存。
- 保存串行化在 `saveQueueRef`，失败会回滚到服务器值。

移动端：

- `apps/mobile/app/bot-settings.tsx` 使用 `SettingsGroup`、`MenuPicker`、
  `SettingsInputRow`。
- 保存不是每键 RPC，而是屏幕级 `save()`；`dirty` 决定返回时是否保存。
- 选择项走 `apps/mobile/lib/bots/bot-settings-choices.ts` 的 hook。

### 1.5 数据与兼容现状

- `Bot` 契约在 `packages/contracts/src/bots/bot.ts`。
- Prisma `Bot` 在 `packages/db/prisma/schema.prisma`。
- `mapBot` 在 `packages/db/src/bots/bot-repository.ts`，负责把可空旧数据归一化成契约值。
- `bots.update` 在 `apps/api/src/routes/bots.ts`，通过 `commitBotUpdate` 写库。
- 账号导出/导入在 `packages/contracts/src/account/account-export.ts`、
  `packages/db/src/account/account-export.ts`、`apps/api/src/account/account-import.ts`。
- 设置分析在 `apps/api/src/telemetry/bot-setting-analytics.ts`。
- 设置分组在 `packages/contracts/src/bots/bot-settings-layout.ts`。

## 2. 需求与边界

### 2.1 用户故事

- 作为 Bot 所有者，我想让长对话更早或更晚被总结，以便控制上下文费用和回答质量。
- 作为 Bot 所有者，我想指定“上下文达到 100K / 200K 时再压缩”，而不是只能接受固定
  50 条消息。
- 作为 Bot 所有者，我想限制一个 Bot 一轮最多做多少工具调用，避免它在一个任务里长期
  空转。
- 作为同一 Space 的其他成员，我希望这些设置只影响该 Bot，不影响整个 Space 或部署。

### 2.2 验收标准

- 新建 Bot 默认 `automatic`，升级后已有 Bot 也表现为当前行为。
- 选择 `earlier` 后，模型观察到约 50% 窗口时触发压缩。
- 选择 `near_limit` 后，约 80% 窗口时触发压缩。
- 选择 `custom` 并输入 100000 后，约 100000 input token 时触发；如果模型窗口更小，
  实际阈值不超过窗口的 90%。
- 设置工具上限为 5 后，一轮第 6 次工具调用被拒绝，并显示可继续的提示；用户再发一条
  消息后计数重置。
- 清空工具上限后，行为回到部署默认。
- Web、Electron、移动端读到的值一致；保存失败时界面回到服务器值。
- 旧服务器不返回字段时，新界面不显示这两个设置，避免“保存成功但不生效”。
- 账号导出后重新导入，两个设置保留。

### 2.3 非目标

- 不做 Codync 的“登录配置”“备用 agent 列表”“让 Bot 自己改备用列表”。
- 不做 localDot 的“每 N 步询问是否继续”“连续失败 N 次询问”“硬停止后继续”。
- 不改变审批模式、Block 规则、花费上限、模型 fallback、工具权限。
- 不引入新的全局并发槽、轮询或排队。
- 不改变摘要模型、摘要费用归属或 `history.compaction` 的语义。
- 不把 token 阈值暴露给模型，也不让模型通过工具修改。

## 3. 方案选择

### 3.1 可选触发模型

| 方案 | 触发依据                       | 与参考产品一致 | 主要问题                          |
| ---- | ------------------------------ | -------------- | --------------------------------- |
| A    | 运行时实际观察到的 input token | 是             | 需要把观察值带进完成路径          |
| B    | 保留最近 N 条消息              | 部分           | 100K/200K 无法诚实表达            |
| C    | 字符数 / 字节数                | 否             | 与模型 token 差异大，用户无法理解 |
| D    | 固定时间 / 每轮都压缩          | 否             | 费用不可控，破坏缓存              |

### 3.2 选定方案

**采用方案 A。**

- `automatic` 继续用消息条数，保持当前行为和费用。
- `earlier`、`near_limit`、`custom` 用运行时实际观察到的
  `estimatedInputTokens`。
- 观察值来自 `RuntimeContextDecision`，不是新估算器。
- 没有观察值（脚本化运行、provider 未返回、旧 checkpoint）时回退到 `automatic`。

### 3.3 为什么不直接复用 `shouldEnqueueCompaction`

`shouldEnqueueCompaction` 回答的是“未压缩消息是否超过窗口 + 批次”，不是“上下文是否
接近模型窗口”。它可以作为 `automatic` 的实现，但不能表达 100K / 200K 的 token 语义。

### 3.4 为什么不用消息条数做 custom

同样 100 条消息，可能只有 20K token，也可能超过 500K token。把“指定数量”实现成消息
条数会让用户以为自己在控制上下文，实际控制的是消息数量，违背“不做假开关”的原则。

## 4. 产品行为

### 4.1 压缩模式

设置名：`Compact conversation` / `压缩对话`。

| 模式         | 存储值       | 触发条件                          | 说明                                      |
| ------------ | ------------ | --------------------------------- | ----------------------------------------- |
| 自动（默认） | `automatic`  | 未压缩消息 ≥ 100 条               | 当前行为；总结最早 50 条，保留最近 50 条  |
| 提早         | `earlier`    | 观察 input token ≥ 模型窗口 × 0.5 | 更早压缩，适合长对话、费用敏感            |
| 接近上限     | `near_limit` | 观察 input token ≥ 模型窗口 × 0.8 | 更晚压缩，保留更多原文                    |
| 指定数量     | `custom`     | 观察 input token ≥ 用户阈值       | 阈值 20,000–1,000,000，且不超过窗口 × 0.9 |

补充规则：

- 压缩后仍保留最近 50 条消息原文；更早的消息由摘要覆盖。
- 摘要本身最多 20,000 字符；如果摘要超长，现有逻辑设置 retry-after，不前进游标。
- 自定义阈值只在 `custom` 时读取；切换到其他模式时清空，避免残留值。
- 模型窗口未知时，所有 token 模式回退到 `automatic`。
- 模型窗口小于 20,000 时，自定义阈值仍按窗口 × 0.9 截断；不会因为窗口小而不触发。

### 4.2 防抖与最小新消息

token 模式不能每轮都触发，否则摘要本身可能仍然超过阈值，形成付费循环。

- 只有 `nextMessageSeq - (historyCompactedUpToSeq ?? -1) - 1 >= 5` 时才允许 token 模式
  触发。
- 触发后仍按 50 条一批总结；job 内 backlog 排水继续使用现有消息计数条件。
- 如果摘要后上下文仍高于阈值，至少再产生 5 条新消息才会再次触发。
- 这个最小新消息数不改变 `automatic` 的现有 100 条门槛。

### 4.3 单轮工具上限

设置名：`Tool calls per turn` / `每轮工具调用`。

- 存储值 `null`：不覆盖部署默认。
- 1–1000：该 Bot 的每个 turn 最多执行这么多次工具调用。
- 达到上限后：
  - 不再开始新的工具调用；
  - 已开始的并行调用允许完成；
  - 输出 `I stopped after reaching the limit of N tool calls in this turn. Send another
    message to continue.`；
  - run 正常完成，不记为失败；
  - 用户下一条消息开启新 turn，计数重置。
- 后台 helper 的 run 也使用同一个 Bot 设置，但每个 helper 有独立预算。
- 该设置不改变 `maxConcurrentHelpers`（同时运行的后台 helper 数量）。

### 4.4 默认值与升级行为

- 新 Bot：`conversationCompactionMode = "automatic"`、
  `conversationCompactionTokens = null`、`maxToolCallsPerTurn = null`。
- 已有 Bot：迁移后同样得到上述默认值，行为不变。
- 旧客户端：不发送新字段，服务端保持原值。
- 新客户端连旧服务器：字段缺失，界面隐藏这两个设置；不显示“保存成功但不生效”的假开关。

### 4.5 文案

Web / Electron：

- 分组标题：`Conversation`
- 行标题：`Compact conversation`
- 选项：`Automatic (default)`、`Earlier`、`Near the limit`、`Custom amount`
- 自定义输入：`Tokens`，快捷值 `100K`、`200K`
- 说明：
  - `Keeps the latest 50 messages and summarizes older ones.`
  - `Summarizes when the prompt reaches half the model's context window.`
  - `Summarizes when the prompt reaches 80% of the model's context window.`
  - `Summarizes when the prompt reaches this many tokens.`
- 分组标题：`Task limit`
- 行标题：`Tool calls per turn`
- 说明：`The agent stops after this many tool calls in one turn. Empty means no limit.`

移动端使用同一组文案，但通过 `SettingsGroup` 的 footer 呈现说明；不新增解释性长文。

## 5. 数据模型与契约

### 5.1 `Bot` 字段

`packages/contracts/src/bots/bot.ts`：

```ts
export const CONVERSATION_COMPACTION_MODES = [
  "automatic",
  "earlier",
  "near_limit",
  "custom",
] as const;

export const ConversationCompactionModeSchema = z.enum(CONVERSATION_COMPACTION_MODES);

export const MIN_CUSTOM_CONVERSATION_COMPACTION_TOKENS = 20_000;
export const MAX_CUSTOM_CONVERSATION_COMPACTION_TOKENS = 1_000_000;
export const MAX_CONVERSATION_COMPACTION_WINDOW_RATIO = 0.9;

export const BotConversationCompactionTokensSchema = z
  .number()
  .int()
  .min(MIN_CUSTOM_CONVERSATION_COMPACTION_TOKENS)
  .max(MAX_CUSTOM_CONVERSATION_COMPACTION_TOKENS);

export const MAX_TOOL_CALLS_PER_TURN_LIMIT = 1_000;
export const BotMaxToolCallsPerTurnSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_TOOL_CALLS_PER_TURN_LIMIT);
```

`BotSchema` 增加：

```ts
conversationCompactionMode: ConversationCompactionModeSchema.optional(),
conversationCompactionTokens: BotConversationCompactionTokensSchema.nullable().optional(),
maxToolCallsPerTurn: BotMaxToolCallsPerTurnSchema.nullable().optional(),
```

为什么用 `.optional()` 而不是 `.default()`：

- 旧服务器不返回字段，新客户端用 `undefined` 判断“服务器不支持”，从而隐藏设置。
- `mapBot` 在新服务器上始终写入 `"automatic"` / `null` / `null`，所以新服务器不会
  出现 `undefined`。
- 现有测试 fixture 不需要为每个 Bot 补三个字段。

`UpdateBotInput` 增加同名可选字段；`CreateBotInput` 不需要暴露，因为创建向导不设置
这两个行为；复制 Bot 和导入 Bot 通过仓库输入复制。

### 5.2 归一化函数

`packages/contracts/src/bots/bot.ts` 提供纯函数，Web、移动端、运行时共用：

```ts
export function conversationCompactionTokenThreshold(
  mode: ConversationCompactionMode | null | undefined,
  customTokens: number | null | undefined,
  contextWindow: number | null | undefined,
): number | null;
```

行为：

- `automatic` 或未知模式：返回 `null`（表示使用消息计数）。
- `earlier`：`Math.floor(contextWindow * 0.5)`。
- `near_limit`：`Math.floor(contextWindow * 0.8)`。
- `custom`：`Math.min(customTokens ?? 100_000, Math.floor(contextWindow * 0.9))`。
- `contextWindow` 缺失或不是正数：返回 `null`。
- 结果至少为 1；如果窗口小于 20K，仍允许小于 schema 默认的自定义值，但运行时会按窗口
  截断。

`shouldCompactConversation` 放在 `packages/adapters/src/runtime/context/history-compaction.ts`，
因为它复用现有的 `shouldEnqueueCompaction`，并便于运行时单元测试：

```ts
export function shouldCompactConversation(input: {
  mode: ConversationCompactionMode | null | undefined;
  customTokens: number | null | undefined;
  contextWindow: number | null | undefined;
  observedInputTokens: number | null | undefined;
  nextMessageSeq: number;
  compactedUpToSeq: number | null;
}): boolean;
```

### 5.3 数据库

新增 additive migration：

```sql
-- Additive: older releases keep writing bots without these settings.
ALTER TABLE "bots" ADD COLUMN "conversationCompactionMode" TEXT NOT NULL DEFAULT 'automatic';
ALTER TABLE "bots" ADD COLUMN "conversationCompactionTokens" INTEGER;
ALTER TABLE "bots" ADD COLUMN "maxToolCallsPerTurn" INTEGER;
```

Prisma：

```prisma
conversationCompactionMode   String @default("automatic")
conversationCompactionTokens Int?
maxToolCallsPerTurn          Int?
```

不需要 `-- deferred`：没有 drop、rename 或回填；旧 release 不读这些列。

### 5.4 账号导出/导入

- `packages/contracts/src/account/account-export.ts` 的 `bot` 记录增加三个字段。
- 旧导出缺少字段时回退到 `automatic`、`null`、`null`。
- `packages/db/src/account/account-export.ts` 只导出合法值；未知模式归一化为
  `automatic`，越界 token 归一化为 `null`。
- `apps/api/src/account/account-import.ts` 在 `seed` 中写回三个字段。

### 5.5 RPC 与权限

- 复用 `bots.update`，不新增 RPC。
- 新字段和现有 Bot 设置一样，受 `repos.getBot(context.actor, botId)` 的 Space 隔离保护。
- `bots.duplicate` 复制三个字段；`bots.importCreate` 通过导入记录恢复。
- 不新增环境变量；部署级 `MAX_TOOL_CALLS_PER_TURN` 仍作为 fallback。

### 5.6 设置分析与分组

- `AnalyticsBotSetting` 增加 `conversation_compaction`、`tool_calls`。
- `bot-setting-analytics.ts` 映射三个字段到这两个枚举；不记录 token 数值。
- `BOT_SETTINGS_SECTIONS.advanced` 增加 `conversationCompaction`、
  `maxToolCallsPerTurn`，供设置覆盖检查使用。

## 6. 运行时详细设计

### 6.1 观察值来源

新增 per-request 回调，而不是全局回调：

`packages/adapter-kit/src/types.ts`

```ts
export interface AgentRunRequest {
  // ...
  onContextObserved?: (estimatedInputTokens: number) => void;
}
```

`packages/adapters/src/runtime/pi/pi-runtime.ts` 的 `onUsage` 路径：

```ts
const decision = contextPolicy.getDecision();
if (decision) {
  request.onContextObserved?.(decision.estimatedInputTokens);
  this.onContextDecision?.({
    ...decision,
    runId: request.runId,
    usage,
  });
}
```

为什么放在这里：

- 这是运行时真正选中的上下文，包含工具、系统提示、历史和图片估算。
- 不需要新增 token 估算器，也不会和 `selectContext` 的实际选择不一致。
- 只在模型调用产生 usage 时触发；脚本化运行没有观察值，自动回退。

### 6.2 `RunContext` 字段

`packages/adapters/src/runs/assembly/run-context.ts` 增加：

```ts
contextWindow: number | null;
observedContextTokens: number | null;
```

在 `createRunContext` 中初始化：

```ts
contextWindow: parts.model.resolved.contextWindow ?? null,
observedContextTokens: null,
```

在 `modelTurnRequest` 中传入回调：

```ts
onContextObserved: (estimatedInputTokens) => {
  ctx.observedContextTokens = Math.max(
    ctx.observedContextTokens ?? 0,
    estimatedInputTokens,
  );
},
```

使用 `Math.max` 而不是最后一次赋值：多步 turn 里上下文只会增长；fallback 或较短重试
不应把观察值降回去。进程重启后从 checkpoint 恢复时，新 attempt 会重新观察；没有观察
值时回退到 `automatic`。

### 6.3 触发决策

`enqueueHistoryCompaction` 改为：

```ts
const mode = bot.conversationCompactionMode ?? "automatic";
const customTokens = bot.conversationCompactionTokens ?? null;
const contextWindow = ctx.contextWindow;
const observed = ctx.observedContextTokens;

if (
  (deps.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY) === "current" &&
  shouldCompactConversation({
    mode,
    customTokens,
    contextWindow,
    observedInputTokens: observed,
    nextMessageSeq: updatedThread.nextMessageSeq,
    compactedUpToSeq: updatedThread.historyCompactedUpToSeq,
  })
) {
  await deps.jobs.enqueue(historyCompactJob(thread.id, run.userId));
}
```

`shouldCompactConversation` 的完整语义：

```ts
function shouldCompactConversation(input) {
  const uncompacted = input.nextMessageSeq - (input.compactedUpToSeq ?? -1) - 1;

  if (
    input.mode === "automatic" ||
    input.mode == null ||
    !input.contextWindow ||
    input.observedInputTokens == null
  ) {
    return shouldEnqueueCompaction(
      input.nextMessageSeq,
      input.compactedUpToSeq,
      HISTORY_WINDOW_SIZE,
      COMPACTION_BATCH_SIZE,
    );
  }

  if (uncompacted < MIN_TOKEN_COMPACTION_NEW_MESSAGES) return false;

  const threshold =
    input.mode === "custom"
      ? Math.min(
          input.customTokens ?? DEFAULT_CUSTOM_COMPACTION_TOKENS,
          Math.floor(input.contextWindow * MAX_CONVERSATION_COMPACTION_WINDOW_RATIO),
        )
      : Math.floor(input.contextWindow * (input.mode === "earlier" ? 0.5 : 0.8));

  return input.observedInputTokens >= threshold;
}
```

边界：

- `observedInputTokens = 0` 是有效观察值，用 `== null` 判断，不用 truthy。
- `contextWindow` 必须大于 0；否则回退自动。
- `customTokens` 低于 20K 或高于 1M 时由 schema 拒绝；旧数据在运行时夹紧。
- `automatic` 不读取观察值，避免多一次运行时回调依赖。

### 6.4 触发时机

- 仍在 `completeRun` 末尾，run 已完成、回复已持久化、通知已发送。
- 失败、取消、停止的 run 不触发；下一次成功 turn 会重新观察。
- 后台 helper 的 thread 没有 `thread.botId`，现有 `compactHistory` 会直接返回；不改变。
- 群聊 thread 没有单个 Bot 归属，不改变。

### 6.5 压缩 job 生命周期

保持现有流程：

1. `completeRun` 入队 `history.compact`。
2. worker 调用 `compactHistory(threadId, requesterId)`。
3. 读取 thread、bot、游标、摘要、消息块。
4. 选取最早 50 条未压缩消息。
5. 用 Bot 当前模型与 thinking 生成摘要。
6. 记录 `operationKind: "compaction"` 用量。
7. compare-and-set 写回游标、摘要、generation。
8. 语义记忆 provider 保存摘要（best effort）。
9. 如果仍有 backlog，继续入队。

本次不改变 3–9 的顺序、费用归属或重试策略。

### 6.6 压缩后的 prompt 窗口

- 继续使用 `HISTORY_WINDOW_SIZE = 50` 作为最近窗口。
- `historyWindowSize` 不改；`conversationCompactionMode` 只决定何时触发，不决定 prompt
  发送多少条。
- 这样避免“设置 custom 200K”同时改变 prompt 缓存前缀和费用模型。
- `run-assembly-records.ts` 仍最多加载 200 条；50 条窗口在 200 条以内。

### 6.7 工具预算

`toolCallBudgetFor` 改为：

```ts
export function toolCallBudgetFor(
  runId: string,
  savedCount = 0,
  maxToolCalls?: number,
): ToolCallBudget {
  const limit = maxToolCalls ?? maxToolCallsPerTurn();
  // ...
}
```

`pi-runtime.ts`：

```ts
trackedBudget = toolCallBudgetFor(
  request.runId,
  typeof saved?.toolCallCount === "number" ? saved.toolCallCount : 0,
  request.maxToolCallsPerTurn,
);
```

`modelTurnRequest`：

```ts
maxToolCallsPerTurn: bot.maxToolCallsPerTurn ?? undefined,
```

语义：

- Bot 设置优先于部署环境变量。
- 部署环境变量仍作为 fallback；未设置时保持不限。
- `saved.toolCallCount` 在 resume 时恢复；如果用户把上限改到低于已用次数，下一次调用
  立即停止，这是预期行为。
- 并行调用允许完成；`exceeded` 后不再开始新调用。
- 每个 run 的预算独立；父 agent 和 helper 不共享计数。

### 6.8 子 agent / 后台 helper

- 后台 helper 是独立 run，拥有独立 `runId` 和独立工具预算。
- helper 的请求由同一个 Bot 组装，因此继承 `maxToolCallsPerTurn`。
- helper 的线程没有 `thread.botId`，不参与对话压缩；这是现有约束，不在本次扩展。
- 父 turn 的压缩设置不会影响 helper 的上下文窗口；helper 的 prompt 仍按现有规则组装。

### 6.9 多实例、队列与幂等

- 入队发生在完成 turn 的 worker；job 可被任意 worker 执行。
- `historyCompactJobKey(threadId)` 保证同一 thread 的 job 替换而不是堆积。
- `historyCompactedUpToSeq` 和 `historyCompactionGeneration` 的 compare-and-set 保证
  并发压缩不重复写摘要。
- 两个 turn 同时完成可能都入队；job key 去重，最多多一次摘要尝试。
- 不新增轮询、全局并发上限或手工重试列。

### 6.10 失败与恢复

| 场景               | 行为                                          |
| ------------------ | --------------------------------------------- |
| usage 回调未触发   | 回退 `automatic` 消息计数                     |
| 模型窗口未知       | 回退 `automatic`                              |
| 摘要 provider 失败 | 现有 job 重试；游标不前进                     |
| 摘要超长           | 设置 `historyCompactionRetryAfterSeq`；不前进 |
| 数据库短暂不可用   | 现有 job 重试；不阻塞 turn 完成               |
| 用户修改压缩设置   | 下一个 turn 生效；进行中的 job 使用已入队参数 |
| 用户修改工具上限   | 下一个 turn 生效；resume 的 attempt 使用新值  |
| job 进程崩溃       | 现有 job 重试；run 已持久化                   |

### 6.11 安全与隐私

- 观察值只包含 token 数，不包含消息内容。
- 日志只记录 mode、阈值、观察值、窗口、消息条数；不记录摘要或对话文本。
- 新字段不包含 secret；账号导出只导出行为设置。
- 工具上限只限制调用次数，不绕过审批、Block 或权限。
- 压缩摘要仍按现有 `historyCompactionSummary` 存储和清理。

### 6.12 可观测性

新增日志（无内容）：

- `history.compact.triggered`
  - `thread.id`
  - `bot.id`
  - `history.compact.mode`
  - `history.compact.threshold_tokens`
  - `history.compact.observed_tokens`
  - `history.compact.context_window`
  - `history.compact.uncompacted_messages`
- `history.compact.skipped`
  - `reason`: `no_observation` / `below_threshold` / `too_few_messages` /
    `unknown_window`

分析：

- `bot_setting_changed` 的 `setting` 使用 `conversation_compaction` 和 `tool_calls`。
- 不上报 token 数值或模型 id。

## 7. UI 设计

### 7.1 Web / Electron 组件树

`apps/web/src/pages/shell/bots/bot-panel.tsx`

```text
PanelSection "Conversation"
  SettingsCard
    ConversationCompactionRow
      OptionSelect (automatic | earlier | near_limit | custom)
      [custom] Input tokens + preset buttons 100K / 200K
      helper text
      error text
    ToolCallLimitRow
      Input number, empty = No limit
      helper text
      error text
```

`ConversationCompactionRow` 放在
`apps/web/src/pages/shell/bots/bot-settings-sections.tsx`，与 `ParallelWorkRow` 同级。

### 7.2 保存时序

Web 使用现有 `enqueueSave` 串行队列：

1. 用户改变模式。
2. 组件立即更新本地状态。
3. `enqueueSave` 发送 `conversationCompactionMode` 和
   `conversationCompactionTokens`（非 custom 时为 null）。
4. 保存成功，更新 `savedAdvanced` 等价快照。
5. 保存失败，回滚到 `bot` 的服务器值，显示 `Could not save`。

custom 输入：

- 只有 blur / Enter 才提交，避免每键 RPC。
- 空输入视为 `100000`（默认自定义值），并写回输入框。
- 非法值不提交，显示范围错误，保留用户输入。
- 选择 `100K` / `200K` 快捷值等价于提交对应 token。

### 7.3 旧服务器保护

- 当 `bot.conversationCompactionMode === undefined` 且
  `bot.maxToolCallsPerTurn === undefined` 时，不渲染 `Conversation` 分组。
- 只要任一字段存在，就渲染分组；缺失的字段使用默认值。
- 这样新客户端连旧服务器不会出现“保存了但没生效”的假开关。

### 7.4 移动端

`apps/mobile/app/bot-settings.tsx`：

- `SettingsGroup label="Conversation"` 内放 `MenuPicker`。
- 选择 `custom` 后显示 `SettingsInputRow`，`keyboardType="number-pad"`，
  `accessibilityLabel="Tokens"`。
- `SettingsGroup label="Task limit"` 内放 `SettingsInputRow`，
  placeholder `No limit`。
- 不新增自定义弹窗；使用原生菜单和系统键盘。
- `save()` 中把三个字段加入 `input`，并加入 `dirty` 判断。
- 保存失败时保留草稿并显示错误；`pendingRef` 防止双击。

### 7.5 可访问性

- `OptionSelect` / `MenuPicker` 有可读标签 `Compact conversation`。
- 自定义输入有 `aria-label` / `accessibilityLabel` `Tokens`。
- 说明文字和输入通过视觉邻近关联；不依赖 placeholder 作为唯一标签。
- 错误文本使用 `role="alert"` 等价样式（现有 `text-destructive` 行）。
- 不新增仅靠颜色表达的状态。

### 7.6 E2E 与截图

- 新增或扩展现有 Bot 设置 E2E：打开设置、切到 `Earlier`、保存、刷新、断言值。
- 新增 custom 输入：选择 `Custom amount`、输入 100000、保存、刷新。
- 新增工具上限：输入 5、保存、刷新；清空后保存。
- CI 截图展示新分组和 custom 状态；PR 描述引用该截图。
- 不新增 feature-specific runner 或 fake service；复用现有 Bot 设置 fixture。

## 8. 测试计划

### 8.1 契约单元测试

- 四种模式合法；未知模式拒绝。
- custom token 20,000–1,000,000；越界、空、负数、小数拒绝。
- 工具上限 1–1,000；null 清空；0、1001、小数拒绝。
- `conversationCompactionTokenThreshold` 在窗口缺失、窗口小于 20K、窗口大于 1M 时的夹紧。
- `shouldCompactConversation` 的自动、无观察值、少消息、低 token、高 token 表驱动。

### 8.2 运行时单元测试

- `onContextObserved` 在每次 usage 后调用，取最大值。
- 脚本化运行没有观察值，回退 automatic。
- `enqueueHistoryCompaction` 对四种模式分别入队/不入队。
- 小于 5 条新消息时 token 模式不入队。
- custom 阈值被窗口 90% 截断。
- `toolCallBudgetFor` 优先使用 Bot 限制；null 回退环境变量；0/未设置不限。
- resume 时 saved count 恢复；超过限制后停止。
- 并行批次完成后才 abort。

### 8.3 集成测试

- `bots.update` 往返三个字段；非法值返回 400。
- `bots.duplicate` 复制三个字段。
- 账号导出/导入往返；旧导出缺字段回退。
- 旧服务器字段缺失时 `mapBot` 返回 undefined；新服务器返回默认值。
- 迁移在空库和已有 Bot 上都能 apply。

### 8.4 Web 组件测试

- 默认显示 `Automatic (default)`。
- 切到 `Earlier` 清空 token。
- 切到 `Custom amount` 显示输入和 100K/200K。
- 输入 150000 后 blur 提交。
- 越界显示错误且不提交。
- 工具上限空值提交 null；合法值提交；非法值显示错误。
- 保存失败回滚。

### 8.5 移动端测试

- 菜单选项和 custom 输入出现/隐藏。
- dirty 检测包含三个字段。
- 保存请求包含正确字段；清空工具上限发送 null。
- 保存失败保留草稿并显示错误。

### 8.6 机械检查

- `pnpm exec biome check --write <files>`
- `pnpm --filter @rakazo/contracts check`
- `pnpm --filter @rakazo/db check`
- `pnpm --filter @rakazo/adapters check`
- `pnpm --filter @rakazo/api check`
- `pnpm --filter @rakazo/worker check`
- `pnpm --filter @rakazo/web check`
- `pnpm --filter @rakazo/mobile check`
- `pnpm checks`
- 目标 Vitest：契约、运行时、Web、移动端。

### 8.7 未测试/不测试

- 不在维护者机器上跑桌面 Playwright；由 CI 虚拟显示执行。
- 不跑完整 Web E2E 作为本地例行验证；推送后看 CI。
- 不用真实 provider 产生费用；运行时用 fixture/scripted runtime。

## 9. 发布与回滚

### 9.1 发布顺序

1. 合并契约 + 迁移 + 仓库映射。
2. 合并运行时观察与触发。
3. 合并 Web UI。
4. 合并移动端 UI。
5. 合并 E2E 截图和文档。

可以作为一个 PR，但提交顺序按上述分层，便于 review。

### 9.2 兼容

- 旧 API + 新数据库：旧代码不读新列，正常。
- 新 API + 旧客户端：旧客户端不发送新字段，保持默认。
- 新客户端 + 旧 API：字段缺失，界面隐藏设置。
- 旧 job + 新字段：job payload 不含设置，压缩时从 Bot 读取；旧 release 的 job 不读新
  字段，行为保持自动。

### 9.3 回滚

- 代码回滚即可；列保留，不影响旧代码。
- 不写 drop migration；后续如需要再按 `-- deferred` 规则处理。
- 若发现 token 触发过频，可先把 `earlier` / `near_limit` / `custom` 在 UI 隐藏，
  数据库值保留；`automatic` 不受影响。

### 9.4 监控

- 观察 `history.compact.triggered` 的频率、mode 分布、observed tokens。
- 观察 compaction job 失败率、摘要超长 retry 次数。
- 观察 `toolCallBudgetExceeded` 的 run 数，判断默认值是否需要调整。

## 10. 实施计划

### Phase 0：设计确认

交付：本文。

退出标准：确认 token 语义、工具上限范围、是否包含 localDot check-ins。

### Phase 1：契约与数据

- 新增常量、schema、归一化函数、单元测试。
- Prisma 字段和 additive migration。
- `mapBot`、`bots.update`、`bots.duplicate`、账号导出/导入。
- 设置分析和分组。

退出标准：契约、db、api 类型检查通过；迁移可 apply；单元测试通过。

### Phase 2：运行时

- `AgentRunRequest.onContextObserved`。
- `RunContext.contextWindow` / `observedContextTokens`。
- `shouldCompactConversation` 和 `enqueueHistoryCompaction`。
- `maxToolCallsPerTurn` 预算覆盖。
- 运行时单元测试。

退出标准：四种模式的触发测试通过；工具预算测试通过；adapters/worker 检查通过。

### Phase 3：Web

- `ConversationCompactionRow`、`ToolCallLimitRow`。
- Bot 面板接入、保存/回滚。
- 组件测试。

退出标准：Web 类型检查和组件测试通过；E2E 可手动走通。

### Phase 4：移动端

- 设置组、菜单、输入、dirty/save。
- 测试。

退出标准：移动端类型检查通过；保存路径测试通过。

### Phase 5：验证与 PR

- Biome、全部目标检查、`pnpm checks`。
- 更新 E2E 和截图。
- PR 描述按 `## What` / `## Why` / `## Changes` / `## Tested` 写；包含用户文案引用。
- 按 `pr-watch` 流程跟 CI 和 review bot。

退出标准：CI 绿；review bot 无未解决 actionable comment；截图已附。

## 11. 风险登记

| 风险                  | 影响         | 缓解                                                    |
| --------------------- | ------------ | ------------------------------------------------------- |
| token 观察值缺失      | 设置不生效   | 回退 automatic；日志 skipped 原因                       |
| 摘要本身超过阈值      | 每轮重复压缩 | 最小 5 条新消息 + 90% 夹紧 + 摘要大小上限               |
| fallback 模型窗口更小 | 压缩偏晚     | 现有 context selection 先失败；后续可记录 active window |
| 旧服务器静默丢弃字段  | 假开关       | 字段缺失时隐藏 UI                                       |
| 迁移锁表              | 发布延迟     | additive default 列；Postgres 11+ 快速默认              |
| 工具上限过低          | 任务被截断   | 软停止、可继续；范围 1–1000                             |
| 设置保存竞态          | 覆盖新值     | 复用 `enqueueSave` 串行队列和回滚                       |
| UI 文案过多           | 违背极简     | 说明只放在 footer；不重复控件文案                       |

## 12. 开放问题

1. “指定数量”是否按 token 理解？本文按 token 设计；如果用户预期是“最近消息条数”，
   需要改回方案 B。
2. 工具上限是否只做“每轮工具调用”，还是也要 localDot 的“每 N 步询问 / 连续失败询问”？
   本文只做前者。
3. 是否需要在 UI 显示当前模型窗口或实际生效阈值？本文先显示固定说明，不显示动态窗口。
4. 是否需要对 `earlier` / `near_limit` 的 50% / 80% 做实验或可配置？本文先写死常量，
   后续用实验框架再调。

## 13. 当前草稿与本文的差异

工作区里已有一版未提交草稿，采用“最近消息窗口”实现。它只能表达
`automatic`、`earlier`、`near_limit`、`custom` 的消息条数，不满足本文的 token 语义。
评审通过后按本文重做触发逻辑；契约字段、数据库字段、UI 结构可以复用，但
`conversationCompactionWindow` 改名为 `conversationCompactionTokens`，并删除消息窗口
的 UI。
