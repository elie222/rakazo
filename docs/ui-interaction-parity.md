# UI 与交互体系对齐：Linger 参考方案

状态：PR 1–4 已实现；PR 5 待执行。

范围：Web 与 Electron 的产品界面；移动端只同步 Web 抽屉与触控规范。侧边栏的详细方案见
[`sidebar-redesign.md`](./sidebar-redesign.md)，本文是它的上层设计。

落地计划：[`ui-interaction-parity-plan.md`](./ui-interaction-parity-plan.md)。

## 1. 结论

Linger 比 Rakazo 好，不是某一个页面的问题，而是四个系统同时更完整：

1. **层级**：一级、二级、内容三层清楚；当前在哪、还能去哪，一眼可答。
2. **密度**：14px 正文、56px 行高、32px 控件、8px 圆角，节奏稳定；Rakazo 不少地方靠留白和字号硬撑层级。
3. **反馈**：悬停、按下、聚焦、加载、流式输出都有明确但克制的反馈；Rakazo 有状态，但缺少统一的动效语法。
4. **表面**：Linger 用语义表面、描边和阴影建立深度；Rakazo 多数时候只有一层背景和边框。

推荐做法：**不复制 Linger 的品牌皮肤，复制它的系统。**

- 采用：三层导航、56px 行、32px 控件、语义表面/阴影、统一的 150/200ms 动效、按下缩放、悬停揭示操作、加载延迟淡入、流式揭示、FLIP 重排。
- 适配：Rakazo 的 token、shadcn/Base UI、lucide、单色系统、移动端原生优先。
- 不采用：Linger 的暖色相、Geist/Noto Sans SC 字体、hugeicons、Room/Library/Wiki 信息架构、灰色外框 + 白色卡片桌面壳。

## 2. 调研方法

- 逐项对比 Linger 与 Rakazo 的设计 token、基础控件、导航、列表行、菜单、加载/流式状态、动效和移动端。
- 只把“可迁移的交互模式”写进方案；品牌资产、字体、图标和具体 IA 属于产品决策，不默认照搬。
- 所有尺寸以 Web 1rem = 16px、正文 14px 为基准；移动端另列触控尺寸。

## 3. 系统差距

### 3.1 字体与密度

| 维度     | Linger                | Rakazo          | 判断                                              |
| -------- | --------------------- | --------------- | ------------------------------------------------- |
| 正文字号 | 14px                  | 14px            | 一致                                              |
| 行高     | 1.5（21px）           | 20px            | Linger 更松，长文更易读                           |
| 字距     | 0.02em                | 0（正文）       | Linger 更“排版过”                                 |
| 字重     | 400 / 470 / 580 / 640 | 400 / 500 / 600 | Linger 的可变字重更细腻，但系统字体做不到 470/580 |
| 标题     | 18/20/24px，负字距    | 15/17/22/26px   | Rakazo 阶梯更多，但实际使用不统一                 |
| 列表行高 | 56px                  | 多数行接近 56px | 方向一致，需统一                                  |

结论：

- 不换字体，先把**行高、字重、字距、标题阶梯**统一。
- 正文保持 14px；行高从 20px 调到 21px 需要全局视觉验证，先在列表/聊天正文试点。
- 字重继续用 400/500/600；不要为了模仿 470/580 引入可变字体。
- 标题按 `text-heading3`/`text-heading2` 的层级使用，不把 15/17/22 当同一种标题。

### 3.2 表面与深度

| 维度 | Linger                                           | Rakazo                              | 判断                      |
| ---- | ------------------------------------------------ | ----------------------------------- | ------------------------- |
| 表面 | canvas / surface / surface-soft / sidebar / rail | background / card / muted / sidebar | Rakazo 够用，但使用不一致 |
| 描边 | 1px 语义描边 + 柔和阴影                          | 多数只有 1px 边框                   | 缺少“抬起”的层级          |
| 阴影 | outline / sm / md / lg / xl / button             | Tailwind 默认 + 少量自定义          | 需要一套语义阴影          |
| 圆角 | 4 / 6 / 8 / 12 / 16                              | `--radius` 12 + 控件圆角            | 接近，统一即可            |

结论：

- 增加语义阴影：`shadow-outline`、`shadow-control`、`shadow-popover`、`shadow-dialog`。
- 表面只使用现有 token：`bg-background`、`bg-card`、`bg-muted`、`bg-sidebar`。
- 不为“像 Linger”给每个卡片加阴影；只在浮层、对话框、当前行和输入聚焦时使用。

### 3.3 控件

| 维度     | Linger                                     | Rakazo                                                    | 判断                                |
| -------- | ------------------------------------------ | --------------------------------------------------------- | ----------------------------------- |
| 控件高度 | 28 / 32 / 36 / 44                          | 24 / 28 / 32 / 36 / 48                                    | 接近                                |
| 按下反馈 | `active:scale(0.97)`                       | `active:translate-y-px`                                   | Linger 的缩放更“有手感”             |
| 焦点     | 2px ring                                   | 3px ring                                                  | Rakazo 更重，需统一                 |
| 加载     | Button `loading` + spinner                 | 组合 Spinner                                              | 可复用，但缺少统一 loading 状态     |
| 变体     | primary/secondary/ghost/subtle/danger/info | default/outline/secondary/ghost/destructive/text/floating | Rakazo 更全，但 floating 与默认混用 |

结论：

- 全站控件统一按下缩放 `0.97`，替换 `translate-y-px`；`prefers-reduced-motion` 下关闭。
- 焦点环统一为 2px `ring-ring`，避免 3px 与 2px 混用。
- 给 `Button` 增加 `loading` 约定（或统一 `Spinner + disabled` 组合），所有提交按钮复用。
- 保留 `floating` 变体，但只用于悬浮在滚动内容上的控件；普通表单不用。

### 3.4 导航与层级

| 维度   | Linger                 | Rakazo                  | 判断              |
| ------ | ---------------------- | ----------------------- | ----------------- |
| 一级   | 持久 rail              | App rail + 侧栏按钮混合 | 采用 rail         |
| 二级   | 独立列表               | 单侧栏                  | 采用独立列表      |
| 当前项 | 浅底 + 图标不透明      | 浅底                    | 补齐图标/标签状态 |
| 展开   | 品牌交叉淡出、标签淡入 | 仅图标态                | 采用交叉淡入      |
| 移动端 | 抽屉内 rail + 列表     | 抽屉                    | 保留，补 rail     |

详细布局、尺寸和验收见 [`sidebar-redesign.md`](./sidebar-redesign.md)。

### 3.5 列表行

Linger 的行语法：

- 56px 高，36px 头像，14px 标题，12px 预览。
- 悬停/聚焦时行底变浅，右侧操作淡入并缩放 0.92→1。
- 标题在操作下方用 mask 渐隐，而不是被省略号切断。
- 置顶、未读、运行中、失败用独立的小徽标/圆点，不改变行高。
- 点击整行导航；操作按钮不触发导航。

Rakazo 现状：

- roster 已有头像、标题、预览、未读点、运行/错误状态和右键菜单。
- 悬停操作存在，但标题/操作的空间关系不统一；部分行用省略号，部分直接盖住。
- 行高由内容决定，长标题会挤压预览。

结论：

- 抽出共享 `ListRow` 语法：`min-h-14`、`rounded-lg`、`px-2 py-2`、`gap-2`、`avatar-9`。
- 右侧操作使用统一 `RowActions`：绝对定位、淡入、缩放、mask 标题。
- 状态只用一个圆点/徽标；不同时出现两个。
- 行内不使用 `h-*` 手写控件高度；按钮用 `size`。

### 3.6 动效

| 动效   | Linger                 | Rakazo   | 判断                |
| ------ | ---------------------- | -------- | ------------------- |
| 微交互 | 150ms                  | 150ms    | 一致                |
| 浮层   | 150ms ease-out         | 150ms    | 接近                |
| 布局   | 200ms                  | 200ms    | 一致                |
| 按下   | 0.97 缩放              | 1px 下移 | 改为缩放            |
| 新消息 | 450ms 弹入 + 1.6s 揭示 | 流式揭示 | 统一为“弹入 + 揭示” |
| 重排   | FLIP                   | 拖拽重排 | 加 FLIP             |
| 加载   | 120ms 延迟淡入         | 直接出现 | 加延迟淡入          |

结论：

- 建立 motion token：`--motion-micro`、`--motion-floating`、`--motion-layout`、`--motion-pop`。
- 所有动效尊重 `prefers-reduced-motion`；不新增无限循环动画。
- 列表重排用 FLIP；拖拽本身不动画。
- 路由加载延迟 120ms 再淡入，避免快速路由闪烁。

### 3.7 菜单、弹层与表单

- Linger 的 action menu 支持 hover 打开、子菜单、焦点管理和视口翻转；Rakazo 的 shadcn 菜单已经具备大部分能力。
- 差距在**行内更多菜单的打开方式**：Linger 悬停即可展开，Rakazo 需要先点。
- 表单方面，Linger 的字段高度/标签/错误提示节奏统一；Rakazo 有 `FieldGroup/Field/FieldLabel`，但仍有手写间距。

结论：

- 行内“更多”菜单支持 hover 打开（仅非破坏性操作）；破坏性操作仍需点击。
- 所有表单使用 `FieldGroup`/`Field`/`FieldLabel`；不再手写 label 间距。
- 弹层统一阴影、圆角、进入方向和焦点环。

### 3.8 加载、空状态与错误

- Linger：路由加载延迟淡入；列表有骨架；空状态一句话；错误可重试。
- Rakazo：有 `PageLoading`、`Spinner`、空状态，但各页面写法不一致。

结论：

- 抽出 `RouteLoading`、`ListSkeleton`、`EmptyState`、`InlineError` 四个共享模式。
- 加载超过 120ms 才显示；加载完成淡出。
- 空状态只保留一句“现在没有什么”，不写解释性长文。
- 错误必须给出重试；不静默失败。

### 3.9 移动端

- Linger 在移动端保留 44px 触控目标，并用 `@media (hover: none)` 让操作常驻。
- Rakazo 的移动端 Web 仍有些 28/32px 控件。

结论：

- 移动端 Web 的最小触控目标 44px；行内操作在 `hover: none` 下常驻。
- 原生移动端继续使用 Expo/native 控件，不套 Web 交互。
- 抽屉内 rail + 列表宽度按侧边栏方案执行。

### 3.10 可访问性

- 焦点可见、键盘顺序、`aria-current`、`aria-expanded`、`aria-label` 是底线。
- Linger 的悬停菜单有焦点管理和 Escape 关闭；Rakazo 需要统一。
- 动效关闭后不能丢失状态。

## 4. 目标系统

### 4.1 Token

**字体**

- 保持系统字体，不新增字体依赖。
- 正文 14px / 21px；标题按现有 `text-heading*`。
- 字重 400 / 500 / 600；不再新增 470/580。
- 正文 `letter-spacing: 0.01em` 作为试点；不全局强推 0.02em。

**表面**

- `background`：页面。
- `card`：卡片/浮层。
- `muted`：次级表面。
- `sidebar`：rail + 列表。
- 新增语义阴影：`shadow-outline`、`shadow-control`、`shadow-popover`、`shadow-dialog`。

**控件**

- 高度继续走 `control-size`：`xs/sm/default/lg/xl`。
- 按下缩放 0.97。
- 焦点环 2px。
- 圆角：控件 8px，卡片 12px，浮层 12–16px。

**动效**

| Token               | 值                          | 用途             |
| ------------------- | --------------------------- | ---------------- |
| `--motion-micro`    | 150ms                       | 悬停、颜色、图标 |
| `--motion-floating` | 150ms                       | 菜单、工具提示   |
| `--motion-layout`   | 200ms                       | rail/列表宽度    |
| `--motion-pop`      | 450ms                       | 新消息弹入       |
| `--motion-sweep`    | 1.6s                        | 流式文字揭示     |
| `--ease-out`        | `cubic-bezier(0,0,0.2,1)`   | 进入             |
| `--ease-standard`   | `cubic-bezier(0.4,0,0.2,1)` | 状态变化         |

### 4.2 共享模式

| 模式              | 用途                                     | 复用位置              |
| ----------------- | ---------------------------------------- | --------------------- |
| `ListRow`         | 56px 行 + 头像 + 标题/预览 + 状态 + 操作 | 侧栏、活动、Artifacts |
| `RowActions`      | 悬停/聚焦淡入 + mask 标题                | 所有列表行            |
| `Pressable`       | 按下缩放 + 焦点环                        | 按钮、行、卡片        |
| `RouteLoading`    | 120ms 延迟淡入                           | 路由切换              |
| `ListSkeleton`    | 列表骨架                                 | 侧栏、活动            |
| `EmptyState`      | 一句话空状态                             | 列表/页面             |
| `InlineError`     | 错误 + 重试                              | 列表/页面             |
| `FloatingSurface` | 阴影/圆角/进入方向                       | 菜单、弹层            |

### 4.3 不做的视觉

- 不复制 Linger 的暖色相、Geist/Noto Sans SC、hugeicons、灰色外框 + 白卡。
- 不新增第二种主色；保持单色。
- 不为每个卡片加阴影；深度只在需要时出现。
- 不为了动画而动画；所有动效必须解释“状态变化”。

## 5. 实施计划

### Phase 0：基线与截图

- 截取 Chats、Board、Activity、Artifacts、设置、移动端抽屉、明暗主题。
- 记录当前控件高度、行高、阴影、动效、焦点环。
- 确认没有未合并的 UI 冲突。

### Phase 1：Token 与基础模式

- 增加 motion/阴影 token。
- 统一按下缩放、焦点环、控件 loading。
- 抽出 `ListRow`、`RowActions`、`Pressable`、`RouteLoading`、`ListSkeleton`、`EmptyState`、`InlineError`。
- 不改变页面结构；先把“零件”统一。
- 验收：现有页面视觉回归通过；无布局位移。

### Phase 2：Shell 与侧边栏

- 按 [`sidebar-redesign.md`](./sidebar-redesign.md) 实施 rail + 二级列表。
- 这是用户感知最大的一步；先做布局，再做行/动效。
- 验收：侧边栏方案的全部 AC。

### Phase 3：聊天列表、消息与输入区

- 列表行统一 56px；悬停揭示操作；置顶/未读/状态统一。
- 消息弹入 + 流式揭示；卡片阴影/圆角；输入区聚焦阴影。
- 验证长文、代码块、附件、引用、流式输出。

### Phase 4：菜单、弹层、表单与设置

- 行内更多菜单 hover 打开（非破坏性）。
- 表单统一 `FieldGroup/Field/FieldLabel`；控件高度/错误提示统一。
- 弹层统一阴影/圆角/进入方向/焦点。

### Phase 5：移动端 Web

- 44px 触控目标；`hover: none` 常驻操作。
- 抽屉内 rail + 列表；安全区；RTL。
- 原生移动端不动。

### Phase 6：测试与 PR

- 单元/组件/E2E/截图；`pnpm checks`、typecheck、build、bundle budget。
- 每个 PR 只做一个阶段；不把 token、侧栏、聊天、表单混在一个 PR。

## 6. 验收标准

### A. 视觉系统

| ID    | 标准                                             | 验证                        |
| ----- | ------------------------------------------------ | --------------------------- |
| UI-01 | 控件高度只来自 `control-size`，无 `h-*` 手写高度 | `no-control-height-classes` |
| UI-02 | 焦点环统一 2px `ring-ring`                       | 手动/截图                   |
| UI-03 | 按下统一 0.97 缩放，reduced-motion 关闭          | 手动                        |
| UI-04 | 阴影只使用语义 token，无新十六进制色             | 代码审查                    |
| UI-05 | 表面只使用现有 token，单色系统不破               | 明暗截图                    |

### B. 交互

| ID    | 标准                                         | 验证     |
| ----- | -------------------------------------------- | -------- |
| UI-06 | 列表行悬停/聚焦时操作淡入并缩放              | E2E/截图 |
| UI-07 | 行标题在操作下方 mask 渐隐，不出现硬切省略号 | 截图     |
| UI-08 | 行内更多菜单支持 hover 打开（非破坏性）      | E2E      |
| UI-09 | 路由加载 120ms 延迟淡入                      | 手动     |
| UI-10 | 新消息弹入 + 流式揭示                        | E2E/截图 |
| UI-11 | 列表重排 FLIP，拖拽本身不动画                | 手动     |

### C. 导航

| ID    | 标准                                            | 验证      |
| ----- | ----------------------------------------------- | --------- |
| UI-12 | 一级/二级/内容三层清楚，当前项有 `aria-current` | 侧边栏 AC |
| UI-13 | rail 展开/收起交叉淡入，标签不跳动              | 手动      |
| UI-14 | 账户固定在 rail 底部                            | 侧边栏 AC |

### D. 表单与弹层

| ID    | 标准                                       | 验证     |
| ----- | ------------------------------------------ | -------- |
| UI-15 | 所有表单使用 `FieldGroup/Field/FieldLabel` | 代码审查 |
| UI-16 | 弹层统一阴影/圆角/进入方向/焦点            | 截图     |
| UI-17 | 错误可重试，空状态一句话                   | 手动     |

### E. 移动端与可访问性

| ID    | 标准                           | 验证 |
| ----- | ------------------------------ | ---- |
| UI-18 | 移动端 Web 触控目标 ≥44px      | 手动 |
| UI-19 | `hover: none` 下操作常驻       | 手动 |
| UI-20 | 键盘顺序、Escape、焦点返回正确 | E2E  |

### F. 工程

| ID    | 标准                                     | 验证 |
| ----- | ---------------------------------------- | ---- |
| UI-21 | 无新增依赖/字体/图标库                   | diff |
| UI-22 | 无后端/迁移/环境变量                     | diff |
| UI-23 | 无翻译目录改动；新增文案在代码中         | diff |
| UI-24 | TypeScript/单测/`pnpm checks`/build 通过 | 命令 |
| UI-25 | CI E2E 截图已附 PR                       | PR   |

## 7. 风险与开放问题

### 7.1 风险

| 风险                                   | 应对                                        |
| -------------------------------------- | ------------------------------------------- |
| 全局按下缩放影响布局                   | 只用 transform，不改变盒模型；截图对比      |
| 行高从内容撑开改为固定 56px 截断长预览 | 预览单行截断；标题两行时单独行高            |
| 焦点环 3px→2px 可感知变弱              | 在深色/浅色都验证对比度                     |
| 动效过多                               | 只保留状态变化；无无限循环                  |
| 侧栏与顶部渐变联动                     | 头部保持 60px；若改密度，同时改 clearance   |
| 移动端 44px 目标挤压列表               | 行内操作常驻但图标 16px；列表最小宽度 200px |
| 表单迁移范围过大                       | 按页面分批；先共享字段，再逐页替换          |

### 7.2 待确认

1. **建议**：分 5–6 个 PR，先 token/基础模式，再侧栏，再聊天/表单/移动端；不要一个大改版。
2. **建议**：正文先保持 20px，聊天正文试点 21px；先统一字重、字距和标题层级。
3. **建议**：采用按下 `scale(0.97)`，替换 `translate-y-px`。
4. **建议**：行内更多菜单允许 hover 打开；破坏性操作仍需点击。
5. **建议**：第一阶段不采用 Linger 的暖色相/Geist 字体，先把层级、密度和动效做对。
6. **建议**：不采用 Linger 的灰色外框 + 白色卡片桌面壳；保持 Rakazo 现有平面，把深度用在浮层和当前行。

## 8. 不做

- 不复制 Linger 的品牌皮肤、字体、图标和 IA。
- 不为 UI 改版新增后端、数据库、RPC、环境变量或翻译目录。
- 不长期保留两套控件/两套侧栏。
- 不编辑 `CHANGELOG.md`。

## 9. 参考

### Linger

- `apps/web/src/app/globals.css`（type、surface、motion、row、rail）
- `apps/web/src/app/visual-theme.css`（语义色）
- `apps/web/src/components/ui/button.tsx`（按下缩放、loading、tone）
- `apps/web/src/components/ui/action-menu.tsx`（hover 打开、焦点、子菜单）
- `apps/web/src/features/rooms/room-navigation.tsx`（rail）
- `apps/web/src/features/rooms/room-secondary-navigation.tsx`（列表/行）

### Rakazo

- `packages/ui-tokens/src/index.ts`（语义色）
- `packages/ui-web/src/styles.css`（type scale、字体）
- `packages/ui-web/src/components/ui/button.tsx`（控件变体/按下）
- `packages/ui-web/src/components/ui/sidebar.tsx`（侧栏原语）
- `apps/web/src/pages/Shell.tsx`（shell 组合）
- `apps/web/src/pages/shell/sidebar/*`（侧栏、roster、footer、resize）
- `docs/sidebar-redesign.md`（侧边栏详细方案）
