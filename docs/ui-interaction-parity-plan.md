# UI 与交互体系对齐：落地实施计划

状态：PR 1–4 已实现；PR 5 待执行。

设计依据：

- 总方案：[`ui-interaction-parity.md`](./ui-interaction-parity.md)
- 侧边栏详细方案：[`sidebar-redesign.md`](./sidebar-redesign.md)

范围：Web 与 Electron 的 UI/交互体系迁移；移动端 Web 同步触控与抽屉规范。原生移动端不改。

## 1. 这份计划解决什么

设计文档回答“为什么 Linger 更好、应该学什么”；这份计划回答：

- 先做哪一块，后做哪一块。
- 每个 PR 改哪些文件、复用什么、不做什么。
- 每个阶段怎样验证，失败时怎样回滚。
- 哪些是可并行的，哪些是串行的。
- 什么时候可以认为“这一阶段完成”。

原则：

- **先统一零件，再改页面。** 不先改某个页面，避免每个页面各写一套动效。
- **每个 PR 独立可上线。** 不长期保留两套控件、两套侧栏。
- **不复制品牌皮肤。** 保留 Rakazo 的单色 token、shadcn/Base UI、lucide 和原生移动端。
- **不做假开关。** 没有后端能力就不上 UI；没有验证就不算完成。

## 1.1 PR 1 结果

- 已落地 motion/shadow token、按下 0.97 缩放、2px 焦点环、Button loading。
- 已新增 `ListRow`/`RowActions`、`RouteLoading`、`ListSkeleton`、`EmptyState`、`InlineError`。
- 已统一共享控件和 app 内焦点/按下写法；路由级等待改为 120ms 延迟。
- 验证：UI 包 100 测试、Web 2701 测试、`pnpm checks` 153 项、typecheck、生产 Web 构建通过；Web 启动体积 891.9/900 kB。
- 桌面 main 包在本机为 2,760.0/2,760.0 kB（超出 0.0 kB），该包不引用 UI/Web 代码，属于基线紧预算；CI 会确认。

## 1.2 PR 2 结果

- 已落地桌面 rail + 二级列表：56px（浏览器）/ 72px（Electron）图标态、220px 标签态；列表 offcanvas。
- 账户菜单 portal 到 rail 底部；套餐提示保留在列表底部；Artifacts/Board/NavLink 移入 rail 布局。
- Activity 保留为列表模式，Integrations 保留在账户菜单；移动端 rail 推迟到 PR 5。
- 新增 `chat/sidebar.spec.ts`，单条 E2E 通过并产出明暗截图。
- Web 2,701 测试、`pnpm checks` 153 项、typecheck、生产构建通过；Web 启动体积 891.7/900 kB。

## 1.3 PR 3 结果

- 聊天列表行改用 `ListRow`/`ListRowLink`：默认 56px、紧凑密度 44px；标题与预览单行截断，不再各写一套行高。
- Activity 列表使用 `ListRow tone="surface"`，页面表面不再借用侧栏颜色；Artifacts 侧栏保留密集多行列表，只统一卡片圆角、阴影和内边距。
- 新消息 450ms 弹入；流式回复保留全部文字，只叠加 1.6s 低对比扫光；`prefers-reduced-motion` 关闭两者。
- 输入区聚焦时使用语义阴影和 2px 焦点环；发送中按钮显示 Spinner 并 `aria-busy`，阻止重复提交。
- 列表重排使用 Web Animations API 的 FLIP，只在列表签名变化时测量，流式文字不会触发布局读取。
- 新增 `use-flip.test.tsx`、`use-entering-messages.test.tsx`，并在 `transcript.test.tsx`、`composer.test.tsx`、`ActivityList.test.tsx` 补行为断言；`chat/sidebar.spec.ts` 覆盖 56px 行高、隐藏列表的焦点隔离与移动端 Activity 入口。
- 行尾“More”悬浮菜单留给 PR 4：现有聊天菜单是右键上下文菜单，直接复用到悬浮按钮会在窄行上覆盖整行点击（E2E 已复现），因此 PR 3 不提前上线半成品。
- 验证：UI 包 101 测试、Web 2,749 测试、`pnpm checks` 153 项、typecheck、生产构建通过；Web 启动体积 817.9/860 kB。

## 1.4 PR 4 结果

- 弹层统一：popover、dropdown、context menu、select 共用 `floatingSurface`（12px 圆角、`shadow-popover`、1px 描边）；dialog、alert dialog、sheet 使用 `shadow-dialog`，进入时长走 `--motion-floating` / `--motion-layout`。
- 行尾“More”菜单：新增 `ChatRowMenu`，与右键菜单共用 `ChatMenuItems` 和同一份打开状态；`via` 区分 surface，右键与按钮不会同时打开。按钮是行链接的兄弟，点击按钮不会触发导航。
- 菜单项仍是点击激活；悬停只揭示按钮，破坏性操作没有变成悬停即触发。
- 设置行：`SettingsRow` 支持 `htmlFor`、`description`、`descriptionId`，标签与控件建立真实关联；账号、Labs、本机授权三处手写 `<Label>` 已移除；错误提示保留在所属行内。
- 新增 `chat-row-menu.test.tsx` 覆盖按钮打开、surface 状态与 Escape 关闭；`chat/sidebar.spec.ts` 新增一条 E2E，覆盖悬停揭示、菜单打开、焦点返回与行链接仍可点击。
- 无悬停设备上，行操作改为占位而不是覆盖行尾：时间、未读点不再被常驻遮罩吃掉；滚动或改变容器尺寸时 FLIP 不再按过期坐标重排。
- 行链接补回 `w-full text-start`，短行不再只点击文字；拖拽目标只标记 `data-active`，不再同时报告 `aria-current`。
- 验证：UI 包 104 测试、Web 2,774 测试、`pnpm checks` 154 项、typecheck、生产构建通过；Web 启动体积 819.2/860 kB，桌面 main 2,194.3/2,300 kB。

## 2. 交付边界

不做：

- 不新增字体、图标库、动画库或 UI 框架。
- 不新增后端、数据库、RPC、环境变量或翻译目录改动。
- 不编辑 `CHANGELOG.md`。
- 不为单个页面加 feature flag 或一次性 runner。
- 不把 Linger 的暖色相、Geist/Noto Sans SC、hugeicons、Room/Library/Wiki IA 直接搬过来。

## 3. PR 切片

| PR   | 内容                                                                              | 依赖   | 用户可见变化                      | 预估     |
| ---- | --------------------------------------------------------------------------------- | ------ | --------------------------------- | -------- |
| PR 1 | Token、按下/焦点/加载、ListRow、RowActions、RouteLoading、EmptyState、InlineError | 无     | 轻微：控件手感、加载、空/错误状态 | 1.5–2 天 |
| PR 2 | Shell + 侧边栏 rail + 二级列表                                                    | PR 1   | 大：导航层级、侧栏结构            | 2–3 天   |
| PR 3 | 聊天列表、消息、输入区、卡片                                                      | PR 1   | 中：行密度、悬停、流式、输入区    | 2–3 天   |
| PR 4 | 菜单、弹层、表单、设置                                                            | PR 1   | 中：hover 菜单、焦点、字段节奏    | 1.5–2 天 |
| PR 5 | 移动端 Web、RTL、触控                                                             | PR 2/3 | 中：抽屉、44px 目标               | 1–1.5 天 |

总计约 8–11 个工作日，另加 review/CI 等待。PR 3 和 PR 4 可在 PR 1 合并后并行；PR 5 依赖 PR 2/3。

## 4. PR 1：Token 与基础模式

目标：先把全站共用的“手感”统一，不改页面结构。

### 4.1 任务清单

| 任务                          | 文件                                                                                                                                      | 内容                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 Motion token              | `packages/ui-web/src/styles.css`                                                                                                          | 增加 `--motion-micro`、`--motion-floating`、`--motion-layout`、`--motion-pop`、`--motion-sweep`、`--ease-standard`、`--ease-out` |
| 1.2 Shadow token              | `packages/ui-web/src/styles.css`                                                                                                          | 增加 `--shadow-outline`、`--shadow-control`、`--shadow-popover`、`--shadow-dialog`，映射到 Tailwind `shadow-*`                   |
| 1.3 Press 反馈                | `packages/ui-web/src/components/ui/button.tsx`                                                                                            | `active:translate-y-px` → `active:scale-[0.97]`；`motion-reduce:active:scale-100`                                                |
| 1.4 Focus 环                  | `button.tsx`、`input.tsx`、`textarea.tsx`、`select.tsx`、`checkbox.tsx`、`switch.tsx`、`radio-group.tsx`、`stepper.tsx`、`disclosure.tsx` | 统一 `ring-2` + 2px offset；移除 3px 混用                                                                                        |
| 1.5 Button loading            | `button.tsx`                                                                                                                              | 可选 `loading`：渲染 `Spinner`、`aria-busy`、禁用点击                                                                            |
| 1.6 ListRow                   | 新增 `packages/ui-web/src/components/ui/list-row.tsx`                                                                                     | 56px 行、36px 头像、标题/预览、状态、右侧操作                                                                                    |
| 1.7 RowActions                | `packages/ui-web/src/shadcn.css`                                                                                                          | 悬停/聚焦淡入、0.92→1 缩放、标题 mask 渐隐                                                                                       |
| 1.8 RouteLoading              | 新增 `apps/web/src/components/RouteLoading.tsx`                                                                                           | 120ms 延迟淡入；使用 `useTimeout`，不写裸 `setTimeout`                                                                           |
| 1.9 ListSkeleton              | 新增 `packages/ui-web/src/components/ui/list-skeleton.tsx`                                                                                | 3–5 行骨架，复用 `Skeleton`                                                                                                      |
| 1.10 EmptyState / InlineError | 复用 `empty.tsx`，新增 `inline-error.tsx`                                                                                                 | 一句话空状态；错误 + 重试                                                                                                        |
| 1.11 测试                     | `list-row.test.tsx`、`button.test.tsx`、`route-loading.test.tsx`                                                                          | 状态、键盘、加载延迟、reduced motion                                                                                             |

### 4.2 ListRow API 草案

```tsx
<ListRow active={active} actions={<RowActions>…</RowActions>}>
  <ListRowAvatar>
    <BotAvatar … />
  </ListRowAvatar>
  <ListRowContent>
    <ListRowTitle unread={unread}>{name}</ListRowTitle>
    <ListRowDescription>{preview}</ListRowDescription>
  </ListRowContent>
  <ListRowStatus working={working} failed={failed} unread={unread} />
</ListRow>
```

要求：

- 行本身是链接或按钮；操作区不触发导航。
- `active` 用 `aria-current="page"`；不要只靠颜色。
- 行高固定 56px；标题/预览单行截断；长标题不撑高。
- 操作区使用绝对定位 + mask；不改变行宽。
- 操作按钮使用 `size="icon-sm"`，不使用手写高度。

### 4.3 RouteLoading 草案

```tsx
export function RouteLoading() {
  return <PageLoading className="route-loading-surface" />;
}
```

```css
@keyframes route-loading-enter {
  from {
    opacity: 0;
  }
}

.route-loading-surface {
  animation: route-loading-enter 200ms ease-out 120ms both;
}

@media (prefers-reduced-motion: reduce) {
  .route-loading-surface {
    animation: none;
  }
}
```

要求：

- 120ms 内完成的加载不闪屏。
- 不新增轮询；路由加载只表示等待，不重新请求。
- 失败由页面自己的 `InlineError` 处理，不用 loading 兜底。

### 4.4 PR 1 验收

| ID     | 标准                                                 | 证据            |
| ------ | ---------------------------------------------------- | --------------- |
| FND-01 | 所有按钮按下为 0.97 缩放，无布局位移                 | 组件测试 + 截图 |
| FND-02 | 所有控件焦点环 2px，深浅主题可见                     | 明暗截图        |
| FND-03 | Button `loading` 阻止重复点击并暴露 `aria-busy`      | 组件测试        |
| FND-04 | ListRow 56px、36px 头像、标题/预览/状态/操作位置一致 | 截图 + 几何断言 |
| FND-05 | RowActions 悬停/聚焦淡入，标题 mask 渐隐             | 组件测试        |
| FND-06 | RouteLoading 120ms 后淡入，reduced-motion 关闭       | 单测 + 手动     |
| FND-07 | EmptyState 只有一句话，InlineError 可重试            | 组件测试        |
| FND-08 | 现有页面无视觉/布局回归                              | 明暗截图对比    |
| FND-09 | TypeScript、Web 单测、`pnpm checks`、build 通过      | 命令输出        |

## 5. PR 2：Shell 与侧边栏

详细任务、尺寸、交互和验收以 [`sidebar-redesign.md`](./sidebar-redesign.md) 为准；本 PR 的额外要求：

- 先落 `AppSidebarLayout` 骨架，再替换 `AppRail`/`ShellSidebar`。
- 保留 `AppRailLayout` 的 Suspense 行为，页面加载时 rail 不闪。
- 新增 `/app/activity` 路由；Artifacts 移入 app 布局。
- 账户菜单从列表底部移到 rail 底部；移除重复目的地。
- 移动端抽屉内 rail 48px + 列表最小 200px。
- 复用 PR 1 的 `ListRow`/`RowActions`，不另写一套 roster 行。

验收：

- 侧边栏方案 AC-01–AC-34 全部通过。
- 桌面展开/收起、列表收起/恢复、移动端抽屉三套截图。
- 320/390/768/1024/1440 五个宽度无溢出。
- Electron 拖拽区可拖动，按钮可点击。

## 6. PR 3：聊天列表、消息与输入区

### 6.1 任务

| 任务         | 文件                                                     | 内容                                      |
| ------------ | -------------------------------------------------------- | ----------------------------------------- |
| 3.1 行迁移   | `sidebar-roster.tsx`、`ActivityList.tsx`、Artifacts 列表 | 全部改用 `ListRow`/`RowActions`           |
| 3.2 消息弹入 | `transcript.tsx`、`message-view.tsx`                     | 新消息 450ms 弹入；流式文字 1.6s 揭示     |
| 3.3 输入区   | `composer.tsx`                                           | 聚焦阴影、发送按钮 loading、按下缩放      |
| 3.4 卡片     | `message-cards.tsx`、`AskCard.tsx`、`SubagentCard.tsx`   | 统一 12px 卡片圆角、语义阴影、16px 内边距 |
| 3.5 重排     | 新建 `use-flip.ts`（Web Animations API）                 | 列表重排 FLIP；拖拽本身不动画             |
| 3.6 测试     | 聊天行、消息、输入区                                     | 键盘、悬停、流式、reduced motion          |

### 6.2 约束

- 不改消息数据结构、RPC 或流式协议。
- 流式揭示只影响视觉；不延迟实际文本。
- 输入区不新增高度类；继续用 `control-size`。
- 卡片阴影只在卡片/浮层使用，不给每条消息加。

### 6.3 验收

| ID      | 标准                                | 证据            |
| ------- | ----------------------------------- | --------------- |
| CHAT-01 | 行统一 56px，悬停操作一致           | 截图            |
| CHAT-02 | 新消息弹入 + 流式揭示               | E2E/截图        |
| CHAT-03 | 输入区聚焦有明确阴影/焦点环         | 截图            |
| CHAT-04 | 发送按钮 loading 防重复             | 组件测试        |
| CHAT-05 | 卡片圆角/阴影/内边距统一            | 截图            |
| CHAT-06 | 重排 FLIP 平滑，reduced-motion 关闭 | 手动            |
| CHAT-07 | 长文/代码/附件/引用无回归           | 现有测试 + 截图 |

## 7. PR 4：菜单、弹层、表单与设置

### 7.1 任务

- 行内更多菜单支持 hover 打开（仅非破坏性）；破坏性操作点击。
- 统一 Popover/Dialog/Sheet 的阴影、圆角、进入方向、焦点管理。
- 所有表单迁移到 `FieldGroup`/`Field`/`FieldLabel`；不再手写 label 间距。
- 设置页、模型设置、集成、审批页逐页替换字段/控件。
- 错误提示统一 `InlineError`；空状态统一 `EmptyState`。

### 7.2 验收

| ID      | 标准                                           | 证据                |
| ------- | ---------------------------------------------- | ------------------- |
| FORM-01 | 所有表单字段节奏一致                           | 截图                |
| FORM-02 | 行内更多菜单 hover 打开，Escape 关闭，焦点返回 | E2E                 |
| FORM-03 | 弹层阴影/圆角/方向统一                         | 截图                |
| FORM-04 | 错误可重试，空状态一句话                       | 手动                |
| FORM-05 | 设置页无重复说明文案                           | `ux-declutter` 复查 |

## 8. PR 5：移动端 Web、RTL 与触控

### 8.1 任务

- 移动端 Web 触控目标 ≥44px；行内操作在 `hover: none` 下常驻。
- 抽屉内 rail + 列表布局；安全区；关闭按钮。
- RTL：边框、拖拽、图标、菜单方向镜像。
- 320/390 宽度验证；横竖屏。

### 8.2 验收

| ID     | 标准                      | 证据        |
| ------ | ------------------------- | ----------- |
| MOB-01 | 移动端 Web 触控目标 ≥44px | 手动        |
| MOB-02 | `hover: none` 下操作常驻  | 手动        |
| MOB-03 | 抽屉 rail + 列表不溢出    | E2E 窄屏    |
| MOB-04 | RTL 方向正确              | 手动 + 截图 |
| MOB-05 | 原生移动端无改动          | diff        |

## 9. 跨阶段工作

### 9.1 动效

- 只用 transform/opacity；不动画 width/height（侧栏宽度除外）。
- 所有动效尊重 `prefers-reduced-motion`。
- 不新增无限循环动画。
- 动效时长统一用 token，不写散落的 `duration-*`。

### 9.2 可访问性

- 焦点可见、键盘顺序、`aria-current`/`aria-expanded`/`aria-label`。
- 行内操作不抢行导航；操作按钮有可读名称。
- 触控目标 44px；桌面 40px 以上。
- 错误不静默；加载不阻塞输入。

### 9.3 性能

- 不新增轮询；不改变实时流。
- 列表行不重复挂载；重排用 FLIP，不整列表重渲染。
- 启动体积：PR 1 的新组件必须按需导出；不静态引入大依赖。
- 构建后跑 `node scripts/checks/bundle-size.mjs`。

### 9.4 文案与公开安全

- 优先复用现有字符串；新增文案只在代码中，不运行 `intl:extract`。
- PR 描述引用新增文案并说明必要性。
- 不提交本地路径、账号、租户、主机名、真实数据。

### 9.5 截图与设计复查

- 每个 PR 附明暗截图；桌面/移动端按需。
- UI 完成后按 `.agents/skills/ux-declutter/SKILL.md` 复查。
- 不为截图新增 feature flag 或共享工具。

## 10. 测试矩阵

| 层       | 命令                                                            | 何时        | 证据   |
| -------- | --------------------------------------------------------------- | ----------- | ------ |
| 格式     | `pnpm exec biome check --write <files>`                         | 每次改动    | 通过   |
| 类型     | `pnpm --filter @rakazo/web check`                               | 每个 PR     | 通过   |
| 单测     | `pnpm --filter @rakazo/web test`                                | 每个 PR     | 通过   |
| 仓库检查 | `pnpm checks`                                                   | push 前     | 通过   |
| 构建     | `pnpm build`                                                    | 每个 PR     | 通过   |
| 体积     | `node scripts/checks/bundle-size.mjs`                           | 构建后      | 预算内 |
| Web E2E  | nightly / 单 spec                                               | CI          | 截图   |
| 手动     | 320/390/768/1024/1440、明暗、RTL、reduced-motion、Electron 拖拽 | 每个视觉 PR | 记录   |

## 11. 验收标准汇总

### A. 基础模式

| ID     | 标准                              |
| ------ | --------------------------------- |
| FND-01 | 按下 0.97 缩放，无布局位移        |
| FND-02 | 焦点环 2px，可见                  |
| FND-03 | Button loading 防重复             |
| FND-04 | ListRow 56px 行规范               |
| FND-05 | RowActions 悬停/聚焦揭示          |
| FND-06 | RouteLoading 120ms 延迟           |
| FND-07 | EmptyState/InlineError 统一       |
| FND-08 | 无现有页面回归                    |
| FND-09 | TypeScript/单测/checks/build 通过 |

### B. 侧边栏

以 `sidebar-redesign.md` 的 AC-01–AC-34 为准，另加：

| ID       | 标准                                  |
| -------- | ------------------------------------- |
| SHELL-01 | 侧栏只使用 PR 1 的 ListRow/RowActions |
| SHELL-02 | 桌面/平板/手机三套布局都通过截图      |
| SHELL-03 | 账户菜单固定，无重复目的地            |

### C. 聊天

| ID      | 标准                         |
| ------- | ---------------------------- |
| CHAT-01 | 行高/头像/标题/预览/状态统一 |
| CHAT-02 | 新消息弹入 + 流式揭示        |
| CHAT-03 | 输入区聚焦阴影/焦点环        |
| CHAT-04 | 发送 loading 防重复          |
| CHAT-05 | 卡片圆角/阴影/内边距统一     |
| CHAT-06 | FLIP 重排                    |
| CHAT-07 | 长文/代码/附件/引用无回归    |

### D. 表单与弹层

| ID      | 标准                             |
| ------- | -------------------------------- |
| FORM-01 | FieldGroup/Field/FieldLabel 统一 |
| FORM-02 | 行内菜单 hover 打开/焦点返回     |
| FORM-03 | 弹层阴影/圆角/方向统一           |
| FORM-04 | 错误可重试、空状态一句话         |
| FORM-05 | 无重复说明文案                   |

### E. 移动端与 RTL

| ID     | 标准                   |
| ------ | ---------------------- |
| MOB-01 | 44px 触控目标          |
| MOB-02 | `hover: none` 常驻操作 |
| MOB-03 | 抽屉 rail + 列表不溢出 |
| MOB-04 | RTL 镜像正确           |
| MOB-05 | 原生移动端无改动       |

### F. 工程与 PR

| ID     | 标准                   |
| ------ | ---------------------- |
| ENG-01 | 无新增依赖/字体/图标库 |
| ENG-02 | 无后端/迁移/环境变量   |
| ENG-03 | 无翻译目录改动         |
| ENG-04 | 文件/文件夹限制通过    |
| ENG-05 | CI 截图已附 PR         |
| ENG-06 | review bot 无未解决项  |

## 12. 风险与回滚

| 风险                 | 应对                                                   |
| -------------------- | ------------------------------------------------------ |
| 全局按下缩放影响布局 | 只用 transform；截图对比                               |
| 焦点环变细后对比不足 | 明暗主题验证；必要时提高 ring 对比                     |
| 行高固定截断长预览   | 预览单行；标题单行截断；需要两行时单独行高             |
| 动效过多             | 只保留状态变化；无循环动画                             |
| 侧栏与顶部渐变联动   | 头部保持 60px；若改密度，同时改 `--chat-top-clearance` |
| 移动端 44px 目标挤压 | 行内操作常驻但图标 16px；列表最小 200px                |
| 表单迁移范围大       | 按页面分批；先共享字段，再逐页替换                     |
| 新组件增加启动体积   | 按需导出；构建后跑 bundle budget                       |

回滚：

- 每个 PR 只改前端，可独立 revert。
- 无数据、无迁移、无外部副作用。
- 不长期保留两套实现；回滚即恢复上一版。

## 13. 时间与顺序

| 阶段 | 预估          | 依赖           |
| ---- | ------------- | -------------- |
| PR 1 | 1.5–2 天      | 无             |
| PR 2 | 2–3 天        | PR 1           |
| PR 3 | 2–3 天        | PR 1           |
| PR 4 | 1.5–2 天      | PR 1           |
| PR 5 | 1–1.5 天      | PR 2/3         |
| 合计 | 8–11 个工作日 | 另加 review/CI |

关键路径：PR 1 → PR 2 → PR 3/4 → PR 5。PR 3 和 PR 4 可在 PR 1 合并后并行；不要在一个分支上同时改侧栏、聊天和表单。

## 14. Definition of Done

每个 PR 完成时必须满足：

- [ ] 范围内任务全部完成。
- [ ] 组件测试/单测覆盖新行为。
- [ ] 明暗截图；桌面/移动端按需。
- [ ] `pnpm exec biome check --write` 通过。
- [ ] `pnpm --filter @rakazo/web check` 通过。
- [ ] `pnpm --filter @rakazo/web test` 通过。
- [ ] `pnpm checks` 通过。
- [ ] `pnpm build` + `node scripts/checks/bundle-size.mjs` 通过。
- [ ] 无新增依赖/字体/图标库。
- [ ] 无翻译目录改动；新增文案在代码中。
- [ ] PR 描述包含 What / Why / Changes / Tested。
- [ ] UI 截图按 `ux-declutter` 复查。
- [ ] 可回滚；无数据副作用。

## 15. 待确认

1. **建议**：按 5 个 PR 执行，先 PR 1，再 PR 2；不要一个大改版。
2. **建议**：正文先保持 20px，聊天正文试点 21px。
3. **建议**：按下统一 `scale(0.97)`，替换 `translate-y-px`。
4. **建议**：行内更多菜单 hover 打开；破坏性操作点击。
5. **建议**：第一阶段不换字体/暖色相/桌面壳。
6. **建议**：侧栏头部保持 60px，避免联动顶部渐变。

## 16. 参考

- [`ui-interaction-parity.md`](./ui-interaction-parity.md)
- [`sidebar-redesign.md`](./sidebar-redesign.md)
- `packages/ui-web/src/components/ui/button.tsx`
- `packages/ui-web/src/components/ui/input.tsx`
- `packages/ui-web/src/components/ui/sidebar.tsx`
- `packages/ui-web/src/styles.css`
- `apps/web/src/components/PageLoading.tsx`
- `apps/web/src/components/ErrorNotice.tsx`
- `apps/web/src/pages/shell/sidebar/*`
