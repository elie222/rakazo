# 对话顶部渐变模糊：调研与设计

状态：已实现（Web / Electron）；移动端保持现有渐变。

落地计划：[`chat-top-fade-implementation-plan.md`](./chat-top-fade-implementation-plan.md)。

范围：Web 对话页的顶部边缘，Electron 桌面端复用同一份 Web UI。移动端已有同类渐变，
本次不引入原生模糊。

## 1. 目标

对话滚动时，顶部内容在悬浮头部下方逐渐淡出并模糊，而不是被一条硬边切断。参考效果：
顶部约一行文字的高度内，消息先失去清晰度，再融入页面背景，最后完全消失；头部的机器人
名称胶囊和操作按钮保持清晰。

这个效果只改变视觉过渡，不增加控件、文案或布局，也不改变滚动的命中区域。

## 2. 调研：Codync 的实现

### 2.1 代码位置

- Codync 桌面端 `apps/desktop/src/renderer/views/thread/ThreadView.tsx:211`
- Codync 桌面端 `apps/desktop/src/renderer/views/thread/ThreadView.tsx:298`
- Codync 桌面端 `apps/desktop/src/renderer/views/thread/thread.css:50`

核心 CSS：

```css
.top-fade {
  position: absolute;
  inset: 0 0 -24px;
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    var(--background) 0%,
    color-mix(in srgb, var(--background) 60%, transparent) 35%,
    transparent 100%
  );
}

.top-fade::before {
  content: "";
  position: absolute;
  inset: 0;
  backdrop-filter: blur(20px);
  -webkit-mask-image: linear-gradient(to bottom, #000, transparent 50%);
  mask-image: linear-gradient(to bottom, #000, transparent 50%);
}

@media (prefers-reduced-transparency: reduce) {
  .top-fade::before {
    backdrop-filter: none;
  }
}
```

### 2.2 结构

两层，缺一不可：

1. **父层**：不透明背景色开始，35% 处保留 60% 不透明度，底部完全透明的纵向渐变。
2. **伪元素**：`backdrop-filter: blur(20px)`，再用从上到下的遮罩限制模糊范围：顶部完全
   模糊，到 50% 高度时完全消失。

外层的顶部渐变负责“隐藏”，内层的遮罩模糊负责“柔化”。父层的 `pointer-events: none`
让滚轮、点击和文本选择继续落到下面的对话上。

### 2.3 为什么不能合成一层

如果把背景渐变和模糊放在同一个元素上，模糊会覆盖整个元素高度，包括渐变已经透明的底部
区域。结果是消息在接近清晰可见的位置仍然被模糊，形成新的硬边。

如果直接给滚动容器加遮罩，`backdrop-filter` 只模糊元素背后的内容，不会模糊元素自身的
内容，所以只能淡出、不能模糊；同时遮罩会裁掉滚动容器内的悬停按钮、焦点环和浮层。

因此必须保留“外层渐变 + 内层遮罩模糊”，并让头部浮在两者之上。

### 2.4 其他细节

- 外层向下多伸出约 24px，让淡出在头部底边之后继续完成。
- 头部位于遮罩之上，所以名称胶囊和按钮不会被模糊。
- `prefers-reduced-transparency: reduce` 时只关掉模糊，保留颜色渐变。
- 没有滚动监听，也没有“滚动后才出现”的状态。

## 3. 调研：Rakazo 现状

### 3.1 Web 与 Electron

Electron 运行的就是同一份 Web UI，因此只需要改 Web。

对话列的结构在 `apps/web/src/pages/Shell.tsx:1125`：

- `div.relative.flex.min-h-0.flex-1.flex-col` 是对话列。
- `ChatHeader` 绝对定位在顶部，`z-10`（`apps/web/src/pages/shell/chat/chat-header.tsx:50`）。
- `Transcript` 是普通文档流中的滚动容器（`apps/web/src/pages/shell/chat/transcript.tsx:620`）。
- 头部高度是 `py-3`（12px × 2）加 `size="icon-lg"`（36px），即 60px。
- 滚动内容顶部留白：`pt-20`（80px），`md:pt-[84px]`。

也就是说，静止在顶部时，内容从 80/84px 才开始；头部只占 60px，中间已经预留了 20/24px
的余量。这和 Codync “头部下方再淡出 24px”的尺寸正好对应。

现有层级：

| 层                       | z-index | 说明                       |
| ------------------------ | ------- | -------------------------- |
| 输入区                   | 30      | `Shell.tsx:1225`，底部悬浮 |
| 搜索条、侧栏             | 20      | 顶部搜索与右侧面板         |
| 顶部拖拽条、`ChatHeader` | 10      | 胶囊与按钮                 |
| 消息悬停操作             | 1       | 单条消息的悬停层           |
| 对话滚动内容             | auto    | `Transcript`               |

目前没有顶部渐变。头部的 `Button variant="floating"` 已自带 `bg-muted/90` 和
`backdrop-blur`（`packages/ui-web/src/components/ui/button.tsx:25`），所以胶囊在遮罩之上
仍然保持磨砂观感。

`PageViewHost` 在更外层覆盖整个页面，不受这层影响。

### 3.2 移动端

移动端已有 `ThreadEdgeFade`（`apps/mobile/components/thread/thread-edge-fade.tsx`）：

- 使用 `react-native-svg` 画纵向渐变，只淡出、不模糊。
- iOS 悬浮导航头下方使用顶部版本（`apps/mobile/components/thread/thread-screen.tsx:625`）。
- 输入框上方使用底部版本（`apps/mobile/components/thread/thread-composer-dock.tsx:120`）。
- 项目没有 `expo-blur` 或其他原生模糊依赖。

因此移动端本次保持现状：它有同类的渐隐，只是没有模糊。显式原因：原生全宽模糊需要新增
依赖，且 Android 旧版本的 `RenderEffect` 支持不一致；iOS 26 的系统导航头本身已有材质。

### 3.3 已有但不相干的工具

`packages/ui-web/src/shadcn.css:164` 有一个 `scroll-fade` 工具类，用 `mask-image` 淡出
滚动容器边缘，并带有滚动驱动动画。它目前没有被业务代码使用。

它不能复用：遮罩作用在滚动容器自身，无法模糊内容；用它反而会裁切悬停层和焦点环。

## 4. 方案比较

| 方案                                           | 结论     | 原因                                                                 |
| ---------------------------------------------- | -------- | -------------------------------------------------------------------- |
| A. 对话列内的绝对定位遮罩，CSS 两层渐变 + 模糊 | **采用** | 不改布局、不加状态、不拦截事件，静止在顶部时自然不可见               |
| B. 给 `Transcript` 加遮罩                      | 否决     | 只能淡出不能模糊；会裁切悬停层、焦点环和容器内浮层                   |
| C. 监听 `scrollTop`，滚动后才显示              | 否决     | 需要同步初始状态、跳转、恢复和动画；静止时遮罩本来就不可见，没有收益 |
| D. 改成不透明固定头栏                          | 否决     | 改变现有“内容从头部下方滚过”的产品视觉，并占用内容高度               |

方案 A 的关键前提已经在当前布局里成立：内容顶部留白（80/84px）等于遮罩高度，所以
`scrollTop = 0` 时遮罩只覆盖空白背景，不会压暗第一条消息或“加载更早消息”按钮。

## 5. 设计

### 5.1 组成

```
Shell <main class="bg-background">
└─ div.relative (chatColumnRef)
   ├─ ChatTopFade      z-[5]   ← 新增
   ├─ ChatHeader       z-10
   ├─ ChatFindBar      z-20
   └─ Transcript       z-auto（滚动容器）

Composer 外层          z-30（在对话列之外）
```

遮罩内部：

```
.chat-top-fade          背景纵向渐变：--background → 透明
└─ ::before             backdrop-filter: blur(20px)
                         mask-image: 黑 → 透明（50%）
```

### 5.2 尺寸与视觉

| 项       | 值                                             | 说明                                                          |
| -------- | ---------------------------------------------- | ------------------------------------------------------------- |
| 头部高度 | 60px                                           | `py-3` + 36px 控件                                            |
| 遮罩高度 | 80px / 84px                                    | 与内容顶部留白、`scroll-padding-top` 完全一致；`md` 起为 84px |
| 背景渐变 | `--background` 0% → 60% 不透明 35% → 透明 100% | 与 Codync 一致                                                |
| 模糊半径 | 20px                                           | 与 Codync 一致                                                |
| 模糊遮罩 | 顶部全模糊 → 50% 高度完全透明                  | 模糊不进入已经清晰的内容区                                    |
| 断点     | 48rem（Tailwind `md`）                         | 与 `--chat-top-clearance` 的响应式值一致                      |

### 5.3 单一来源

遮罩高度、滚动内容顶部留白和滚动对齐（`scroll-padding-top`）必须始终相等。现在它们
分别写在不同的类里，后续改字号或头部高度时容易漂移。

实现时在对话列上定义一个变量，供三处共用：

```tsx
<div
  ref={chatColumnRef}
  data-finding={findOpen || undefined}
  className="relative flex min-h-0 flex-1 flex-col
             [--chat-top-clearance:5rem] md:[--chat-top-clearance:5.25rem]"
>
```

- `Transcript` 的 `pt-20 md:pt-[84px]` 改为 `pt-(--chat-top-clearance)`。
- `Transcript` 的 `scroll-pt-16` 改为 `scroll-pt-(--chat-top-clearance)`，让跳转到消息
  和“回复保持”都停在遮罩下方，而不是停在旧的 64px。
- `.chat-top-fade` 的 `height` 使用 `var(--chat-top-clearance, 5rem)`。

Tailwind 4.3.5 已确认支持 `pt-(--custom-property)` 和带响应式变体的自定义属性声明。

### 5.4 代码草案

新组件 `apps/web/src/pages/shell/chat/chat-top-fade.tsx`：

```tsx
import "./chat-top-fade.css";

/** Fades and blurs the transcript where it scrolls under the floating chat header. */
export function ChatTopFade() {
  return (
    <div
      aria-hidden="true"
      data-testid="chat-top-fade"
      className="chat-top-fade pointer-events-none absolute inset-x-0 top-0 z-[5] print:hidden"
    />
  );
}
```

新样式 `apps/web/src/pages/shell/chat/chat-top-fade.css`：

```css
/*
 * The transcript scrolls under the floating header. Fade it into the background and blur
 * the top half of the band; the height comes from the chat column so it matches the
 * transcript's top padding (pt-(--chat-top-clearance)) and stays invisible at rest.
 */
.chat-top-fade {
  height: var(--chat-top-clearance, 5rem);
  background: linear-gradient(to bottom, var(--background), transparent);
  background: linear-gradient(
    to bottom,
    var(--background) 0%,
    color-mix(in srgb, var(--background) 60%, transparent) 35%,
    transparent 100%
  );
}

.chat-top-fade::before {
  content: "";
  position: absolute;
  inset: 0;
  backdrop-filter: blur(20px);
  mask-image: linear-gradient(to bottom, #000, transparent 50%);
}

@media (prefers-reduced-transparency: reduce) {
  .chat-top-fade::before {
    backdrop-filter: none;
  }
}
```

只写标准属性，让构建自动补 `-webkit-`。手写前缀会让 Lightning CSS 在去重时
只保留前缀，反而丢掉标准属性；生产构建已验证会自动输出两种形式。

`Shell.tsx` 中渲染在 `ChatHeader` 之前：

```tsx
<div ref={chatColumnRef} ...>
  <div aria-hidden="true" className="app-drag absolute inset-x-0 top-0 z-10 h-3" />
  <ChatTopFade />
  <ChatHeader ... />
  ...
</div>
```

### 5.5 层级、交互与可访问性

- `z-[5]`：在滚动内容之上、`ChatHeader`（`z-10`）之下。头部的胶囊和按钮不会被模糊。
- 单个消息的悬停操作是 `z-1`，会被遮罩压暗；这是期望行为，它们在顶部本来也看不清。
- `pointer-events: none`：滚轮、点击、文本选择和拖拽继续命中对话；现有 E2E 中
  “头部间隙命中的是 `transcript`”的断言仍然成立。
- `aria-hidden="true"`：纯装饰，不进入无障碍树，不增加可读文案。
- 绝对定位，不参与布局；不会改变消息位置、滚动锚点或输入区高度。
- `print:hidden`：打印对话时不把顶部压暗。

### 5.6 主题、降级与性能

- 颜色只读 `--background` 语义 token，不新增十六进制产品色。遮罩里的 `#000` 是遮罩
  模板，不是可见颜色。
- 先写一条纯透明渐变的兜底，再写 `color-mix` 版本；不支持 `color-mix` 的浏览器仍能
  得到基础淡出。
- 不支持 `backdrop-filter` 时，浏览器忽略模糊声明，渐变继续生效。
- macOS 开启“降低透明度”时关闭模糊，与 Codync 一致。
- 遮罩只有约 84px 高，不加动画、不加 `will-change`，滚动时只做一次合成。头部按钮本来
  已经在用 `backdrop-blur`，新增成本主要是高度和宽度变大。
- 如果真机上的窄屏 Web 出现滚动掉帧，退路是把模糊限制到 `md` 及以上，窄屏只保留渐变；
  这与移动端原生的视觉一致，不需要改结构。

### 5.7 不做的事

- 不加滚动监听，不做“滚下去才出现”的状态。
- 不改 `ChatHeader` 的 DOM、按钮或文案。
- 不引入 `expo-blur` 或其他依赖。
- 不把 `scroll-fade` 工具类套在滚动容器上。
- 本次不做 Web 输入框上方的底部渐变；移动端已有，Web 如需要可复用同一两层结构。
- 不新增翻译文案，不运行 `intl:extract`。

### 5.8 原型验证

用同样的两层 CSS 做了一个独立的临时 HTML 页面，在 Chromium 下分别截图：

- `scrollTop = 0`：第一条消息从留白之后开始，完全清晰，没有被压暗。
- `scrollTop = 320`：顶部文字先模糊、再淡出，头部胶囊和右侧按钮保持清晰，过渡没有硬边。

验证只使用了本文的 CSS，不涉及仓库改动。Tailwind 4.3.5 的
`pt-(--chat-top-clearance)` 与响应式自定义属性也已用同一版本编译确认。

## 6. 改动清单

| 文件                                              | 改动                                                      |
| ------------------------------------------------- | --------------------------------------------------------- |
| `docs/chat-top-fade-design.md`                    | 本文档                                                    |
| `apps/web/src/pages/shell/chat/chat-top-fade.tsx` | 新增遮罩组件                                              |
| `apps/web/src/pages/shell/chat/chat-top-fade.css` | 新增两层渐变与降级规则                                    |
| `apps/web/src/pages/Shell.tsx`                    | 对话列声明 `--chat-top-clearance`，渲染 `<ChatTopFade />` |
| `apps/web/src/pages/shell/chat/transcript.tsx`    | 顶部留白和滚动对齐改用 `--chat-top-clearance`             |
| `apps/web/e2e/chat/chat-header.spec.ts`           | 断言遮罩存在，保留命中测试，更新明暗两套截图              |

没有契约、RPC、数据库、迁移或环境变量改动。

## 7. 验收与测试

实现后：

1. `pnpm checks`：文件夹大小、文件行数、导入边界等检查保持通过。
2. `pnpm --filter @rakazo/web test`：现有组件与页面测试通过。
3. Web E2E（交给 CI 运行，不在本机跑全量）：
   - 对话滚到中部时，顶部消息出现渐隐与模糊，头部胶囊和按钮保持清晰。
   - 滚回 `scrollTop = 0` 时，第一条消息和“加载更早消息”按钮不被压暗。
   - 跳转到较早消息时，目标消息停在遮罩下方，不落在渐隐区。
   - 在头部两枚胶囊之间的空隙点击或滚动，事件仍然落到 `transcript`。
   - 浅色、深色各截一张图；PR 描述里附上 CI 的 E2E 截图。
4. 手动检查：
   - Safari 与 Chromium 下模糊和遮罩一致。
   - macOS“降低透明度”下模糊关闭、渐变保留。
   - Electron 窗口拖动区域（顶部 12px）仍然可以拖动窗口。

## 8. 风险

- **滚动性能**：`backdrop-filter` 在小面积上通常没有问题，但在低端手机上可能掉帧。
  退路是窄屏只保留渐变，见 5.6。
- **与磨砂胶囊叠加**：头部胶囊在遮罩之上，会再次模糊已经淡出的内容。胶囊填充是
  `bg-muted/90`，接近不透明，预计差异很小；明暗两套截图确认，如果发灰再单独评估，
  不改共享的 `Button` 变体。
- **尺寸漂移**：遮罩高度和内容留白通过 `--chat-top-clearance` 绑定；后续改头部高度时
  只需改这一处。
- **旧浏览器**：`color-mix` 或 `backdrop-filter` 缺失时分别退化为基础渐变与纯渐变，
  不会出现硬边或空白。

## 9. 后续可选

- Web 输入框上方增加对称的底部渐变，复用同一两层结构。
- 若其他悬浮头（如 Page 视图）也需要同样效果，再把样式提升为
  `packages/ui-web` 的共享工具类。
- 移动端未来若要模糊，需要先评估原生依赖和 Android `RenderEffect` 的覆盖范围，不在
  本次范围内。
