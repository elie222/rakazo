# 侧边栏改版：Linger 参考方案

状态：PR 2 已实现（桌面）；移动端 rail 留到 PR 5。

范围：Web 与 Electron 的聊天侧边栏；移动端抽屉同步适配。不改后端、数据库、RPC 或翻译目录。

上层方案：[`ui-interaction-parity.md`](./ui-interaction-parity.md)。本文是其中的侧边栏阶段。

## 0. 实现结果（PR 2）

已落地：

- 桌面主 rail：Chats / Activity / Artifacts / Board，宽度 56px（浏览器）或 72px（Electron 窗口控件）收起、220px 展开。
- 二级列表改为 offcanvas：标题、搜索、创建、隐藏列表；rail 上提供“Show chat list”恢复。
- 账户菜单通过 portal 放到 rail 底部；列表底部保留套餐提示、归档和 Passkey 提示。
- Artifacts、Board、NavLink 页面移入 app rail 布局，切页时 rail 常驻。
- Activity 仍是列表模式（持久化开关），不是 `/app/activity` 路由；Integrations 仍在账户菜单。
- 新增 `apps/web/e2e/chat/sidebar.spec.ts`，覆盖 rail 展开/收起、Activity、列表隐藏/恢复和截图。

有意取舍：

- 移动端抽屉暂不放入 rail，留给 PR 5；桌面 rail 先落地。移动端仍是单列抽屉。
- 账户菜单由 `SpaceShell` portal 到 rail；Artifacts/Board 没有 `SpaceShell` 时 rail 底部为空，全局账户入口作为后续补齐。
- 不复制 Linger 的暖色、字体和 hugeicons。

## 1. 背景与结论

反馈是：Linger 的侧边栏比 Rakazo 原版好很多，希望把这种体验带到 Rakazo。

Linger 真正好的地方不是颜色或图标，而是三层清楚的结构：

1. 一条始终存在的窄主 rail，负责一级目的地。
2. 一块可收起的二级列表，负责当前目的地的内容。
3. 一排固定在 rail 底部的账户入口，和内容列表解耦。

Rakazo 现在把一级目的地、聊天列表、搜索、创建、活动和账户都塞进同一个侧栏。功能不少，但层级靠按钮和折叠分组维持，扫一眼很难回答“我现在在哪、还能去哪”。

推荐方案：**采用 Linger 的“主 rail + 二级列表”结构，但按 Rakazo 的信息架构和设计系统重做。**

- 主 rail：Chats、Activity、Artifacts、Board（实验室开启时）、Integrations，底部账户头像。
- 二级列表：Chats 显示现有 bot/group roster；Activity 显示现有活动列表；其余目的地不显示二级列表。
- 主 rail 可在 56px 图标态和 220px 标签态之间切换；二级列表可独立收起；两者都记住用户选择。
- 保留 Rakazo 现有的 token、shadcn 组件、lucide 图标、单色系统和移动端抽屉，不复制 Linger 的配色、字体、hugeicons 或 Room/Library/Wiki 模型。
- 头部高度继续使用现有 60px，避免与刚完成的顶部渐变模糊（84px clearance）产生联动改动。

## 2. 调研：Linger 的侧边栏

### 2.1 结构

Linger 的侧栏由两个并列的导航组成：

```
<aside class="app-navigation">
  <nav class="app-primary-navigation">      // 56px 图标态 / 220px 标签态
    topbar: brand + expand/collapse
    Messages / Library / Wiki / Connectors
    footer: account
  </nav>

  <nav class="app-secondary-navigation">    // 240–460px
    header: title + collapse + utilities
    search
    grouped room list
    resize handle
  </nav>
</aside>
```

关键点：

- 一级目的地永远是链接，不是“切换某个列表模式”的按钮。
- 二级列表只在当前目的地需要列表时出现；Library/Wiki 这类页面可以让 rail 继续存在，列表让位给内容。
- 账户入口固定在 rail 底部，不随列表滚动。
- rail 和列表是兄弟节点，宽度一起参与外层布局；切换时只动画宽度，不重排内部行。

参考：Linger 的 `apps/web/src/features/rooms/room-navigation.tsx:139`、
`apps/web/src/features/rooms/room-secondary-navigation.tsx:208`、
`apps/web/src/app/globals.css:4562`。

### 2.2 尺寸

| 项             | Linger              | 说明                          |
| -------------- | ------------------- | ----------------------------- |
| 主 rail 图标态 | 56px（桌面壳 62px） | 图标 + 工具提示               |
| 主 rail 标签态 | 220px               | 品牌、空间名、文字标签        |
| 二级列表       | 240–460px           | 默认 240–380px，可拖拽        |
| 顶部栏         | 57px（桌面壳 44px） | rail 顶栏、列表头、聊天头对齐 |
| 列表行         | 最小 56px           | 头像 36px + 标题/预览         |
| 搜索           | 28px（手机 44px）   | 圆角输入框或按钮              |
| 动效           | 200ms               | 只动画宽度，拖拽不等待        |

### 2.3 交互

- rail 收起时显示品牌；指针悬停或键盘聚焦时品牌交叉淡出，展开图标淡入。
- rail 展开后显示标签和当前空间名；当前目的地用 `aria-current="page"` 和浅色底标记。
- 二级列表头在桌面显示标题和收起按钮；收起后 rail 上出现“Show Chat list”。
- 列表行悬停时显示置顶和更多操作；操作浮在行上，不改变行高。
- 未读、运行中、失败分别用圆点/徽标表达，标题字重区分未读。
- 移动端抽屉里仍然是 rail + 列表，只是 rail 更窄、标签隐藏。
- 桌面 Electron 的窗口红绿灯放在 rail 顶栏，拖拽区覆盖顶部整条。

### 2.4 为什么看起来更清楚

- **一级和二级分开**：找聊天和找页面不会混在同一列。
- **rail 始终可见**：从聊天跳到 Library 不需要先打开菜单。
- **账户固定**：设置、组织、退出不占用列表滚动区域。
- **列表可收起**：读长文或看 Board 时把列表让出来，但 rail 还在。
- **行密度稳定**：每行同一高度、同一头像尺寸、同一标题/预览节奏。

## 3. 调研：Rakazo 现状

### 3.1 结构

```
<AppRailLayout>
  <AppRail>                    // 72px，Chats / Board
  <ShellPage>
    <ShellSidebar>             // 单个侧栏
      <SidebarHeader>          // 窗口控件、最小化、搜索、活动、创建
      <SidebarRoster>          // Space/section 分组、bot/group 行
      <ArchivedChats>          // 归档
      <SidebarFooter>          // 账户、设置、集成、技能、Artifacts、邀请、退出
    </ShellSidebar>
    <main>聊天/Board</main>
  </ShellPage>
</AppRailLayout>
```

参考：

- `apps/web/src/pages/shell/app-rail.tsx:37`
- `apps/web/src/pages/shell/sidebar/shell-sidebar.tsx:60`
- `apps/web/src/pages/shell/sidebar/sidebar-header.tsx:16`
- `apps/web/src/pages/shell/sidebar/sidebar-roster.tsx:43`
- `apps/web/src/pages/shell/sidebar/sidebar-footer.tsx:71`
- `apps/web/src/pages/Shell.tsx:270`（`miniSidebar`）
- `apps/web/src/lib/preferences/bots-sidebar-pref.ts`

### 3.2 现有尺寸与状态

| 项                 | Rakazo      | 说明                                    |
| ------------------ | ----------- | --------------------------------------- |
| App rail           | 72px        | 仅 Chats / Board                        |
| 侧栏默认宽         | 316px       | 可拖拽                                  |
| 侧栏最小/最大      | 240 / 480px | 吸附到 72px 图标态                      |
| 聊天头             | 60px        | `py-3` + 36px 控件                      |
| 顶部渐变 clearance | 80 / 84px   | 与聊天头联动                            |
| 移动端             | 抽屉 + 蒙层 | rail 在 md 以下隐藏                     |
| 账户菜单           | 侧栏底部    | 设置、集成、技能、Artifacts、邀请、退出 |

### 3.3 现有优点

- roster 已经支持 Space/section 分组、折叠、拖拽排序、右键菜单和未读/运行/错误状态。
- 侧栏宽度、收起状态和密度已经有持久化偏好。
- 移动端抽屉、Electron 窗口控件、RTL 和 reduced-motion 已有基础。
- 设计系统是单色的，行状态已经用 `bg-unread`、`workingDot`、`destructive` 表达。

### 3.4 现有问题

| 问题               | 表现                                                                  | 影响                                        |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------- |
| 一级目的地不完整   | Chats/Board 在 rail，Activity/Artifacts/Integrations 在侧栏或账户菜单 | 同一类入口散落在三个位置                    |
| 侧栏承担太多       | 搜索、活动、创建、列表、归档、账户同列                                | 视线没有主次，首屏找不到重点                |
| 图标态信息弱       | 72px 只有头像/图标，缺少标签和目的地提示                              | 新用户不知道每个图标去哪                    |
| 账户入口在列表底部 | 列表滚动后账户被推到视口外                                            | 设置/退出需要先滚动                         |
| 列表不能独立收起   | 只能整体切到图标态                                                    | 读长内容时没有“保留 rail、让出列表”的中间态 |
| 头部高度不统一     | 聊天头 60px，侧栏头由内容撑开                                         | 两列顶部对不齐                              |

## 4. 差距分析

| 维度      | Linger                           | Rakazo 现状                                 | 结论                             |
| --------- | -------------------------------- | ------------------------------------------- | -------------------------------- |
| 一级导航  | 独立 rail，始终可见              | App rail + 侧栏按钮混合                     | **采用** rail 结构               |
| 二级列表  | 独立、可收起、可拖拽             | 单侧栏                                      | **采用**独立列表                 |
| 账户入口  | rail 底部固定                    | 列表底部                                    | **采用**固定账户                 |
| 列表行    | 56px，头像 + 标题 + 预览 + 状态  | 已接近                                      | **保留并统一规范**               |
| 搜索/创建 | 列表头                           | 侧栏头                                      | **迁移**到列表头                 |
| 活动      | 一级目的地                       | 侧栏模式                                    | **提升**为一级目的地             |
| 主题      | 自定义暖色/蓝点                  | 单色 token                                  | **不复制**，按 Rakazo token 重做 |
| 图标      | hugeicons                        | lucide                                      | **不复制**，统一 lucide          |
| IA        | Messages/Library/Wiki/Connectors | Chats/Activity/Artifacts/Board/Integrations | **适配**，不照搬                 |
| 桌面壳    | 灰色 frame + 白卡                | 现有 shadcn 侧栏                            | **不复制**，只借鉴层级           |

## 5. 信息架构

### 5.1 主 rail（推荐）

| 目的地       | 路由 / 动作                              | 图标             | 二级列表     |
| ------------ | ---------------------------------------- | ---------------- | ------------ |
| Chats        | `/app`、`/app/:botId`、`/app/g/:groupId` | `MessagesSquare` | 显示 roster  |
| Activity     | `/app/activity`                          | `Bell`           | 显示活动列表 |
| Artifacts    | `/app/artifacts`                         | `FolderOpen`     | 不显示       |
| Board        | `/app/board`（实验室开启时）             | `SquareKanban`   | 不显示       |
| Integrations | 打开现有集成 overlay                     | `Plug`           | 不显示       |
| 账户         | 打开现有账户菜单                         | 头像             | 不显示       |

说明：

- Activity 建议从侧栏模式提升为 `/app/activity` 路由；这样 rail 项是真正的链接，前进/后退和深链都成立。
- Artifacts 需要从当前的 `CallLayout` 路由移到新的 app 布局内，否则 rail 在 Artifacts 页会消失。
- Integrations 继续使用现有 overlay，不新增页面；点击 rail 项时打开 overlay。
- Board 继续受 `boardEnabled` 控制；关闭时整项不渲染。
- 账户菜单保留组织切换、用量、设置、技能、邀请、退出；Artifacts 和 Integrations 从菜单移除，避免和 rail 重复。

### 5.2 二级列表

**Chats**

- 头部：标题“Chats”、搜索输入、创建按钮、收起列表按钮。
- 列表：现有 `SidebarRoster`，保留 Space/section 分组、折叠、拖拽、右键菜单、未读/运行/错误状态。
- 底部：归档、Passkey/更新提示；账户不再放在这里。

**Activity**

- 头部：标题“Activity”、搜索、筛选、收起列表按钮。
- 列表：现有 `ActivityList`。
- 创建按钮隐藏；活动不是创建入口。

**Artifacts / Board / Integrations**

- 不显示二级列表；rail 保留，主内容占满剩余宽度。
- 从这些目的地回到 Chats 时，恢复上次的列表宽度和滚动位置。

### 5.3 账户菜单

- 触发：rail 底部头像，`aria-label` 为“Account menu for {name}”。
- 位置：桌面打开到 rail 的 inline-end；移动端打开为底部 sheet 或 popover。
- 内容：组织切换、用量、设置、技能、邀请、退出、主题（如果现有）。
- 移除：Artifacts、Integrations、Board（Board 已在 rail）。
- 保留：PasskeyOffer、桌面更新提示放在列表底部，不与账户菜单混在一起。

### 5.4 路由映射

| 现有路由          | 新布局               | 变化                                |
| ----------------- | -------------------- | ----------------------------------- |
| `/app`            | rail + Chats 列表    | 保持                                |
| `/app/:botId`     | rail + Chats 列表    | 保持                                |
| `/app/g/:groupId` | rail + Chats 列表    | 保持                                |
| `/app/board`      | rail + 内容          | 保持，rail 项从 AppRail 移入新 rail |
| `/app/artifacts*` | rail + 内容          | 移入 app 布局                       |
| `/app/x/:linkId`  | rail + 内容          | 移入 app 布局（如该页需要 rail）    |
| `/app/activity`   | rail + Activity 列表 | 新增路由                            |
| 集成 overlay      | rail 保留            | 不变                                |
| `/onboarding/*`   | 无 rail              | 不变                                |

## 6. 布局与尺寸

### 6.1 桌面

```
┌──────────┬──────────────────────┬─────────────────────────────┐
│          │                      │                             │
│  rail    │   secondary list     │        main content         │
│ 56/220px │   240–440px          │        flex-1               │
│          │                      │                             │
│ brand    │  title  search  +    │                             │
│ items    │  ────────────────    │                             │
│          │  groups              │                             │
│          │  rows                │                             │
│ account  │  archived / notices  │                             │
└──────────┴──────────────────────┴─────────────────────────────┘
```

| 项           | 推荐值         | 理由                                                  |
| ------------ | -------------- | ----------------------------------------------------- |
| rail 图标态  | 56px           | 比现有 72px 更紧凑，给内容让位；44px 触控目标仍放得下 |
| rail 标签态  | 220px          | 与 Linger 一致，能放下空间名和目的地标签              |
| 二级列表默认 | 316px          | 复用现有默认宽度，不改变用户习惯                      |
| 二级列表范围 | 240–440px      | 保留现有最小/默认，最大略收，避免挤压聊天             |
| 顶部栏       | 60px           | 与现有聊天头、顶部渐变 clearance 对齐                 |
| 列表行       | 56px           | 与 Linger 一致；现有 roster 已接近                    |
| 头像         | 36px           | 现有 roster/群头像尺寸                                |
| 行圆角       | 8px            | 现有 `rounded-lg`                                     |
| 行间距       | 2px            | 与现有列表一致                                        |
| rail 项      | 40×40px        | 图标 20px，四周 8px                                   |
| 账户头像     | 36px           | 与行头像一致                                          |
| 动效         | 200ms ease-out | 只动画宽度；reduced-motion 关闭                       |

### 6.2 断点

| 宽度                    | 行为                                                     |
| ----------------------- | -------------------------------------------------------- |
| `< 48rem`（手机）       | 抽屉；rail 48px 图标态 + 列表（最小 200px）；无持久 rail |
| `48–64rem`（平板/窄窗） | rail 56px 图标态；二级列表可收起；默认收起               |
| `≥ 64rem`（桌面）       | rail 默认展开 220px；二级列表显示；可收起                |
| 用户手动切换            | 记住展开/收起；下一次登录沿用                            |

说明：

- 手机抽屉在 320px 宽时：48px rail + 200px 列表 = 248px，低于当前 86vw 的 275px，不会溢出。
- 桌面默认展开是为了让新用户看到标签；如果希望更安静，可以在首次进入时默认收起，作为待确认项。

### 6.3 RTL

- rail 放在 `inline-start`；边框用 `border-e`；列表和聊天之间用 `border-s`。
- 拖拽方向按 `document.documentElement.dir` 反转。
- 账户菜单、工具提示、展开图标方向镜像。
- 不使用 `left/right` 或 `margin-left/right` 写死布局。

### 6.4 Electron

- rail 顶部 60px 放窗口红绿灯和拖拽区；按钮 `app-no-drag`。
- 二级列表头与聊天头同高，拖拽区只覆盖顶部 12px。
- 窗口控件在 macOS 上占 rail 顶栏；Windows/Linux 使用现有 `WindowChrome`。
- 不改变 `handleIpc`、preload 或主进程代码。

## 7. 交互与状态

### 7.1 rail

- 点击展开/收起：`aria-expanded`；展开后显示标签，收起后工具提示。
- 键盘：Tab 聚焦每个目的地；Enter/Space 打开；展开按钮有可见焦点环。
- 当前项：`aria-current="page"` + `bg-sidebar-accent` + `text-sidebar-accent-foreground`。
- 未读：头像右上角 `bg-unread` 圆点；不改变图标颜色。
- 运行中：`workingDot` 小圆点；失败：`destructive` 圆点。
- 空间名：展开态顶栏显示当前 Space 名，截断；收起态只显示品牌标记。

### 7.2 二级列表

- 收起：桌面点击头部按钮；列表宽度动画到 0；rail 上出现“Show Chat list”按钮。
- 展开：点击 rail 上的恢复按钮；回到上次宽度。
- 拖拽：边缘手柄；拖动时不动画，松手后提交；支持方向键、Home/End、Enter。
- 搜索：`Cmd/Ctrl+K` 聚焦；Escape 清空并退出搜索；输入时保留列表滚动位置。
- 创建：仅 Chats 显示 `+`；打开现有 `BotCreatePicker`。
- 行：点击打开；悬停显示置顶/更多；右键打开现有上下文菜单；拖拽排序保持不变。
- 滚动：`rk-scroll` + 顶部/底部 fade；`scrollbar-gutter: stable`，避免宽度跳动。
- 空/加载/错误：骨架行；空状态一句话；加载失败显示重试，不静默。

### 7.3 账户

- 头像固定在 rail 底部；列表滚动不影响。
- 打开菜单时焦点进入菜单；Escape 关闭并回到头像。
- 移动端在抽屉底部显示头像和菜单。
- 组织切换、用量、设置、技能、邀请、退出沿用现有行为。

### 7.4 可访问性

- rail：`<nav aria-label="Sections">`；列表：`<nav aria-label="Chats">` 或 `Activity`。
- 每个目的地有可读名称；收起态通过 tooltip 提供名称。
- 触控目标至少 44×44px（手机）；桌面可 40×40px。
- 焦点环使用 `ring-ring`；不用 `outline: none` 无替代。
- `prefers-reduced-motion` 下关闭宽度/交叉淡入动画。
- 拖拽手柄：`role="separator"`、`aria-orientation="vertical"`、`aria-valuemin/max/now`。

## 8. 视觉规范

### 8.1 Token

| 用途          | Token / 类                                            |
| ------------- | ----------------------------------------------------- |
| rail / 列表底 | `bg-sidebar`                                          |
| 文本          | `text-sidebar-foreground`                             |
| 次要文本      | `text-muted-foreground`                               |
| 分隔线        | `border-sidebar-border`                               |
| 悬停/当前     | `bg-sidebar-accent`、`text-sidebar-accent-foreground` |
| 未读点        | `bg-unread`                                           |
| 运行中        | `bg-workingDot`                                       |
| 失败          | `bg-destructive`                                      |
| 焦点          | `ring-ring`                                           |
| 标题          | `text-body` / `font-medium`                           |
| 预览          | `text-label text-muted-foreground`                    |
| 空间名        | `text-body-sm font-medium`                            |

不新增十六进制色，不使用 `[var(--…)]` 任意值；图标统一 lucide，1.75 描边。

### 8.2 层级

- rail 与列表同底，靠一条 `border-sidebar-border` 分隔；列表与聊天之间再一条。
- 当前行用浅色底，不用蓝色；未读点才是唯一蓝色。
- 行内操作按钮使用 ghost/icon-sm，悬停才出现；键盘 focus-within 也出现。
- 群组头使用 `text-body-sm`、`text-muted-foreground`，折叠箭头 14px。
- 列表底部渐隐到 sidebar 背景，不使用实色遮罩条。

### 8.3 文案

优先复用现有字符串，避免新增翻译：

- Chats、Activity、Artifacts、Board、Integrations 都已在现有 UI 中出现。
- 新增“Show Chat list”/“Hide Chat list”若需要，先在代码中加英文，不运行 `intl:extract`；PR 描述引用新增文案并说明必要性。
- 账户菜单移除重复项后，不新增解释性文案。

## 9. 实施计划

### 9.1 阶段

**Phase 0：基线与截图**

- 用本地登录或 e2e 测试账号截取当前 Chats、Board、Activity、移动端抽屉、明暗主题。
- 记录当前侧栏宽度、收起状态、滚动位置。
- 确认 `apps/web/src/pages/Shell.tsx`、`app-rail.tsx`、`sidebar/*` 没有未合并冲突。

**Phase 1：布局骨架**

- 新增 `AppSidebarLayout`（或改造 `AppRailLayout`），承载 rail + 二级列表 + 内容。
- 引入共享变量：`--app-rail-width`、`--app-sidebar-header-height`、`--app-secondary-width`。
- 先把现有 `AppRail` 和 `ShellSidebar` 包进新布局，保持行为不变。
- 验证：聊天仍可打开，rail 仍显示，移动端不回归。

**Phase 2：主 rail**

- 把 `AppRail` 扩展为 Chats / Activity / Artifacts / Board / Integrations。
- 账户头像移到 rail 底部；拆出 `SidebarAccountMenu`。
- 实现展开/收起、标签、工具提示、`aria-current`、窗口控件。
- 把 Artifacts 路由移入 app 布局；新增 `/app/activity` 路由。
- 验证：每个目的地可到达；前进/后退；深链；移动端抽屉。

**Phase 3：二级列表**

- 把 `SidebarHeader` 拆成列表头：标题 + 搜索 + 创建 + 收起。
- 把 `SidebarRoster`、`ArchivedChats`、`PasskeyOffer`/更新提示放入列表。
- Activity 复用 `ActivityList` + 筛选。
- 实现列表收起/恢复、宽度持久化、拖拽手柄键盘支持。
- 验证：搜索、创建、折叠、拖拽、归档、未读、空/错误状态。

**Phase 4：移动端与响应式**

- 抽屉内 rail 48px + 列表最小 200px；关闭按钮在列表头。
- 48–64rem 默认图标态；≥64rem 默认标签态；记住选择。
- RTL 镜像；触控目标 44px；安全区。
- 验证：320/390/768/1024/1440 宽度；横竖屏；RTL。

**Phase 5：交互与视觉收口**

- 行悬停操作、置顶、右键菜单、拖拽排序、未读/运行/错误。
- 统一行高、头像、标题/预览、间距、圆角、渐隐。
- 明暗主题截图；`ux-declutter` 复查。
- 验证：键盘、焦点、reduced-motion、Electron 拖拽。

**Phase 6：测试与 PR**

- 单元测试：偏好读写、展开/收起、宽度吸附、RTL 方向、账户菜单。
- 组件测试：rail 目的地、`aria-current`、工具提示、列表头。
- E2E：桌面展开/收起、列表收起/恢复、移动端抽屉、Activity、Artifacts、键盘。
- 截图：明暗、桌面、移动端；PR 描述附 CI 截图。
- `pnpm exec biome check --write`、`pnpm --filter @rakazo/web check`、
  `pnpm --filter @rakazo/web test`、`pnpm checks`、`pnpm build`、
  `node scripts/checks/bundle-size.mjs`。

### 9.2 文件清单

| 文件                                                     | 改动                                           |
| -------------------------------------------------------- | ---------------------------------------------- |
| `apps/web/src/pages/shell/app-rail.tsx`                  | 改造为主 rail；新增目的地、账户底部、展开/收起 |
| `apps/web/src/pages/shell/sidebar/shell-sidebar.tsx`     | 拆成 rail + 二级列表布局                       |
| `apps/web/src/pages/shell/sidebar/sidebar-header.tsx`    | 拆成列表头；移除活动/最小化；保留搜索/创建     |
| `apps/web/src/pages/shell/sidebar/sidebar-footer.tsx`    | 拆出账户菜单；移除重复目的地                   |
| `apps/web/src/pages/shell/sidebar/sidebar-roster.tsx`    | 统一行规范；保留现有交互                       |
| `apps/web/src/pages/shell/sidebar/sidebar-layout.tsx`    | 适配新布局/宽度变量                            |
| `apps/web/src/pages/shell/sidebar/use-sidebar-resize.ts` | 复用；补充列表收起联动                         |
| `apps/web/src/lib/preferences/bots-sidebar-pref.ts`      | 新增 rail 展开偏好；迁移旧收起值               |
| `apps/web/src/pages/Shell.tsx`                           | 接线 rail、列表、Activity 路由状态             |
| `apps/web/src/App.tsx`                                   | 移动 Artifacts 路由；新增 Activity 路由        |
| `apps/web/src/styles.css`                                | 共享尺寸变量（如需要）                         |
| `apps/web/e2e/chat/*.spec.ts`                            | 新增侧栏截图与交互断言                         |

### 9.3 状态与持久化

- 复用 `rakazo:bots-sidebar-width:<userId>` 保存二级列表宽度。
- 复用 `rakazo:bots-sidebar-collapsed:<userId>` 作为“二级列表收起”。
- 新增 `rakazo:app-rail-expanded:<userId>` 保存 rail 展开；未设置时按断点默认。
- 旧版 72px 图标态视为“二级列表收起”，首次加载迁移为新的列表收起，不丢用户选择。
- 不新增后端字段、RPC 或数据库迁移。

### 9.4 测试矩阵

| 层   | 覆盖                                                                |
| ---- | ------------------------------------------------------------------- |
| 单元 | 偏好读写、断点默认、宽度吸附、RTL 方向                              |
| 组件 | rail 目的地、当前项、工具提示、列表头、账户菜单                     |
| E2E  | 桌面展开/收起、列表收起/恢复、移动端抽屉、Activity、Artifacts、键盘 |
| 手动 | Electron 拖拽、RTL、reduced-motion、明暗主题、320px 窄屏            |
| 构建 | Tailwind 类、启动体积、桌面主进程不受影响                           |

### 9.5 发布与回滚

- 一个 PR 只做侧边栏改版；不编辑 `CHANGELOG.md`，不编辑翻译目录。
- 无后端、无迁移、无数据副作用；回滚只 revert 前端。
- 如需要降低风险，可先合并布局骨架，再合并视觉/交互；但不要长期保留两套侧栏。

## 10. 验收标准

### A. 信息架构

| ID    | 标准                                                             | 验证               |
| ----- | ---------------------------------------------------------------- | ------------------ |
| AC-01 | 一级目的地只在 rail 出现一次，不在账户菜单重复                   | 代码审查 + 截图    |
| AC-02 | Chats、Activity、Artifacts、Board、Integrations 都可从 rail 到达 | E2E 逐项点击       |
| AC-03 | 当前目的地有 `aria-current="page"` 和可见选中态                  | E2E + 可访问性检查 |
| AC-04 | Activity 使用独立路由，前进/后退和深链成立                       | E2E                |
| AC-05 | Artifacts 页面保留 rail，不回到无 rail 布局                      | E2E                |

### B. 布局与尺寸

| ID    | 标准                                          | 验证            |
| ----- | --------------------------------------------- | --------------- |
| AC-06 | 桌面 rail 56px 图标态、220px 标签态           | 几何断言        |
| AC-07 | 二级列表默认 316px，可在 240–440px 拖拽       | 几何断言        |
| AC-08 | 顶部栏 60px，与聊天头对齐                     | 截图 + 几何断言 |
| AC-09 | 行高 56px、头像 36px、标题/预览层级一致       | 截图            |
| AC-10 | 320px 宽度下抽屉不溢出（rail 48 + 列表 ≥200） | E2E 窄屏        |
| AC-11 | RTL 下 rail 在右侧、边框/拖拽方向镜像         | 手动 + 截图     |

### C. 交互

| ID    | 标准                                                 | 验证            |
| ----- | ---------------------------------------------------- | --------------- |
| AC-12 | rail 展开/收起有 200ms 宽度动画；reduced-motion 关闭 | 手动 + 代码审查 |
| AC-13 | 二级列表可独立收起/恢复，并记住宽度                  | E2E             |
| AC-14 | 搜索 `Cmd/Ctrl+K` 聚焦，Escape 清空并退出            | E2E             |
| AC-15 | 创建按钮只出现在 Chats，打开现有创建菜单             | E2E             |
| AC-16 | 行悬停显示置顶/更多；右键菜单和拖拽排序保持          | E2E + 手动      |
| AC-17 | 未读、运行中、失败状态与现有含义一致                 | 组件测试 + 截图 |
| AC-18 | 账户固定在 rail 底部，滚动列表不移动                 | E2E             |
| AC-19 | 移动端抽屉打开/关闭、蒙层、滑动边缘正常              | E2E             |
| AC-20 | Electron 顶部拖拽区可拖动窗口，按钮可点击            | 手动            |

### D. 视觉与可访问性

| ID    | 标准                                            | 验证                       |
| ----- | ----------------------------------------------- | -------------------------- |
| AC-21 | 只使用语义 token，无新增十六进制色              | 代码审查 + `no-hex-colors` |
| AC-22 | 单色系统：当前项用 ink/accent，未读点是唯一蓝色 | 明暗截图                   |
| AC-23 | 触控目标 ≥44px（手机）、焦点环可见              | 手动 + 可访问性检查        |
| AC-24 | 收起态每个图标有可读 tooltip                    | 组件测试                   |
| AC-25 | 行、分组头、列表头有统一节奏；无多余说明文案    | `ux-declutter` 复查        |
| AC-26 | 明暗主题、320/390/768/1024/1440 截图通过        | 截图                       |

### E. 工程

| ID    | 标准                                     | 验证          |
| ----- | ---------------------------------------- | ------------- |
| AC-27 | TypeScript、Web 单测、`pnpm checks` 通过 | 命令          |
| AC-28 | 生产构建与 bundle budget 通过            | `pnpm build`  |
| AC-29 | 无新增依赖、无后端/迁移/环境变量         | diff          |
| AC-30 | 无翻译目录改动；新增文案在代码中         | diff          |
| AC-31 | 文件夹 ≤40 代码文件、文件 ≤1,000 行      | `pnpm checks` |
| AC-32 | CI E2E 截图已附 PR 描述                  | PR            |

## 11. 风险与开放问题

### 11.1 风险

| 风险                         | 应对                                                                  |
| ---------------------------- | --------------------------------------------------------------------- |
| 顶部渐变模糊依赖 60px 聊天头 | 本方案保持 60px；若未来改密度，同时更新 `--chat-top-clearance` 和 E2E |
| 移动端 56px rail 挤压列表    | 手机用 48px rail + 200px 最小列表；320px 下验证                       |
| Electron 拖拽区覆盖按钮      | rail 顶栏统一 `app-drag`，按钮 `app-no-drag`；手动验证                |
| rail 展开导致内容跳动        | 只动画宽度；主内容用 `min-w-0`；截图对比                              |
| 账户菜单移动后焦点丢失       | 打开时聚焦第一项；Escape 回到头像                                     |
| RTL 拖拽方向反了             | 复用现有 `direction()`；E2E 加 RTL 检查                               |
| 旧用户偏好迁移丢失           | 旧 72px 图标态映射为列表收起；首次加载写入新键                        |
| 信息架构变化导致找不到设置   | 账户菜单保留设置；rail 只放高频目的地                                 |

### 11.2 待确认

1. **rail 目的地**：是否保留 5 项（Chats/Activity/Artifacts/Board/Integrations），还是把 Integrations 留在账户菜单？
2. **默认状态**：桌面默认展开 220px，还是默认收起 56px、只在悬停时显示标签？
3. **Activity**：是否接受新增 `/app/activity` 路由，还是继续作为侧栏模式？
4. **Artifacts 路由**：是否把它移入 app 布局，让 rail 常驻？
5. **头部密度**：保持 60px，还是借这次改版统一降到 Linger 的 44px（会联动顶部渐变 clearance）？
6. **账户菜单位置**：rail 底部固定，还是保留在二级列表底部？

## 12. 不做

- 不复制 Linger 的配色、字体、hugeicons、Room/Library/Wiki 模型。
- 不新增后端、数据库、RPC、环境变量或翻译目录改动。
- 不为这次改版加 feature flag；如需要分批，按布局/视觉拆 PR，但不长期保留两套侧栏。
- 不改桌面 IPC、主进程或 preload。
- 不编辑 `CHANGELOG.md`。

## 13. 参考

### Linger

- `apps/web/src/features/rooms/room-navigation.tsx:139`
- `apps/web/src/features/rooms/room-secondary-navigation.tsx:208`
- `apps/web/src/components/ui/use-sidebar-width.ts`
- `apps/web/src/app/globals.css:4562`

### Rakazo

- `apps/web/src/pages/shell/app-rail.tsx:37`
- `apps/web/src/pages/shell/sidebar/shell-sidebar.tsx:60`
- `apps/web/src/pages/shell/sidebar/sidebar-header.tsx:16`
- `apps/web/src/pages/shell/sidebar/sidebar-roster.tsx:43`
- `apps/web/src/pages/shell/sidebar/sidebar-footer.tsx:71`
- `apps/web/src/pages/shell/sidebar/sidebar-layout.tsx:14`
- `apps/web/src/pages/shell/sidebar/use-sidebar-resize.ts:17`
- `apps/web/src/lib/preferences/bots-sidebar-pref.ts`
- `packages/ui-web/src/components/ui/sidebar.tsx`
