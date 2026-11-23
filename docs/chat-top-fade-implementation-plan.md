# 对话顶部渐变模糊：落地开发计划

状态：已执行（Web / Electron）；`chat-header` E2E 留给 nightly / CI 运行。

设计依据：[`chat-top-fade-design.md`](./chat-top-fade-design.md)。

范围：Web 对话页；Electron 桌面端复用同一份 Web UI。移动端原生不改。

## 1. 交付结果

实现后应得到：

1. 对话滚动时，顶部内容在悬浮头部下方渐隐并模糊，过渡没有硬边。
2. 头部胶囊、按钮和拖拽区保持清晰、可点击、可拖动。
3. 静止在 `scrollTop = 0` 时，第一条消息和“加载更早消息”按钮不被压暗。
4. 明暗主题都使用语义 token，不出现硬编码产品色。
5. 支持 `prefers-reduced-transparency` 降级；没有新增运行时依赖。
6. 移动端原生对话的现有渐变保持不变。

不交付：

- Web 输入框上方的底部渐变。
- 移动端原生模糊。
- 任何 RPC、数据库、迁移、环境变量或翻译文案改动。

## 执行结果

- `ChatTopFade` 已接入对话列；遮罩高度、内容顶部留白和 `scroll-padding-top` 由
  `--chat-top-clearance` 统一为 80 / 84px。
- TypeScript、Web 全量单测、`pnpm checks`、生产构建和启动体积预算均通过。
- 用生产构建 CSS 在真实 Chromium 中验证：1280px 下遮罩/留白/滚动对齐均为 84px，
  390px 下均为 80px；`::before` 的 computed backdrop filter 为 20px blur，
  mask 为纵向渐变；头部 `z-index` 高于遮罩。
- 实现中发现并修正两处：手写 `-webkit-` 会让 Lightning CSS 去重掉标准属性，改为只写
  标准属性；`scroll-padding-top` 从旧的 64px 改为与遮罩同高，避免跳转消息落在渐隐区。
- `apps/web/e2e/chat/chat-header.spec.ts` 已补充几何、层级、模糊、静止与窄屏断言；
  该 spec 属于 nightly，PR CI 默认不跑，截图与最终通过需触发 nightly 后确认。

## 2. 已核实的前置事实

| 事实                                | 位置                                                                                        | 对实现的影响                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| Electron 运行同一份 Web UI          | `docs/desktop-app.md:3`                                                                     | 只改 Web，桌面端自动覆盖               |
| 对话列是 `relative` 容器            | `apps/web/src/pages/Shell.tsx:1125`                                                         | 可以放绝对定位遮罩                     |
| 头部绝对定位在顶部，`z-10`          | `apps/web/src/pages/shell/chat/chat-header.tsx:50`                                          | 遮罩必须低于 `z-10`                    |
| 头部高度 60px                       | `py-3` + 36px 控件                                                                          | 遮罩约 84px，下方留 24px 过渡          |
| 内容顶部留白与滚动对齐 80/84px      | `apps/web/src/pages/shell/chat/transcript.tsx:620`                                          | 遮罩高度、留白与跳转对齐同源           |
| 输入区在对话列之外，`z-30`          | `apps/web/src/pages/Shell.tsx:1225`                                                         | 遮罩不会压到输入区                     |
| 搜索条 `z-20`、侧栏 `z-20`          | `apps/web/src/pages/Shell.tsx:1133`、`apps/web/src/pages/shell/resizable-side-panel.tsx:78` | 遮罩不能高于这些层                     |
| 消息悬停操作 `z-1`                  | `apps/web/src/pages/shell/chat/transcript.tsx:681`                                          | 顶部悬停按钮会被遮罩压暗，符合预期     |
| 移动端已有 `ThreadEdgeFade`         | `apps/mobile/components/thread/thread-edge-fade.tsx`                                        | 本次不改                               |
| `chat` 目录现有 21 个非测试代码文件 | 目录统计                                                                                    | 新增 1 个 `.tsx` 后为 22，低于 40 上限 |
| `chat-header` spec 属于 nightly     | `apps/web/playwright.config.ts:27`                                                          | PR CI 默认跳过；截图需手动触发 nightly |
| Tailwind 4.3.5 支持 `pt-(--var)`    | 已用同版本编译验证                                                                          | 可以用 CSS 变量统一留白与高度          |

## 3. 实施步骤

### Step 0：准备与基线

目的：先确认工作区干净、基线可复现，避免把已有失败带进验收。

操作：

```bash
git status --short
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web test
pnpm checks
```

记录：

- 基线中已存在的失败（如果有）写进执行记录，不要在本 PR 修无关问题。
- 确认 `packages/i18n/locales/*/messages.po` 的现有改动不是本任务产生的；本任务不碰它们。

完成标准：

- 你知道哪些失败是基线已有的。
- 分支基于最新 `main`，且没有与 `Shell.tsx`、`transcript.tsx`、`chat-header.spec.ts`
  冲突的未合并改动。

### Step 1：建立顶部留白与滚动对齐的单一来源

目的：让遮罩高度、内容顶部留白和 `scroll-padding-top` 永远相等，避免以后改头部高度时
漂移，也避免跳转到消息时落在渐隐区。

文件：

- `apps/web/src/pages/Shell.tsx`
- `apps/web/src/pages/shell/chat/transcript.tsx`

改动 1：在对话列上声明变量。

```tsx
// apps/web/src/pages/Shell.tsx
<div
  ref={chatColumnRef}
  data-finding={findOpen || undefined}
  className="relative flex min-h-0 flex-1 flex-col
             [--chat-top-clearance:5rem] md:[--chat-top-clearance:5.25rem]"
>
```

改动 2：滚动容器改用变量。

```tsx
// apps/web/src/pages/shell/chat/transcript.tsx
className={`rk-scroll isolate flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden
  overflow-y-auto scroll-pt-(--chat-top-clearance) scroll-pb-7
  pt-(--chat-top-clearance) pb-12 md:pb-13 ${TRANSCRIPT_CONTENT_PADDING}`}
```

注意：

- 原来的 `pt-20 md:pt-[84px]` 必须删除，不能和 `pt-(--chat-top-clearance)` 并存。
- 原来的 `scroll-pt-16` 也必须替换，否则跳转和“回复保持”会停在 64px，落在遮罩下半段。
- 变量必须和 `pt-(--chat-top-clearance)` 在同一个变更里提交；否则变量不存在时
  `padding-top` 会失效。
- 不要在 `Transcript` 内部再声明一份变量，单一来源放在对话列。

完成后验证：

```bash
pnpm --filter @rakazo/web check
```

浏览器几何检查（1280px 与 390px 两个宽度）：

- `getComputedStyle(transcript).paddingTop` 和 `scrollPaddingTop` 分别为 `84px`、`80px`。
- 头部位置、首条消息位置与改动前一致；此步骤不应产生任何视觉变化。

完成标准：

- 两个断点的 computed padding 与 scroll padding 正确。
- 没有引入水平滚动或布局位移。

### Step 2：新增遮罩组件与样式

目的：把视觉效果封装在一个无状态、无业务依赖的组件里。

新增 `apps/web/src/pages/shell/chat/chat-top-fade.tsx`：

```tsx
import "./chat-top-fade.css";

/**
 * Fades and blurs the transcript where it scrolls under the floating chat header.
 * Its height comes from the chat column's --chat-top-clearance, so it matches the
 * transcript's top padding and stays invisible at rest.
 */
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

新增 `apps/web/src/pages/shell/chat/chat-top-fade.css`：

```css
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

要求：

- 两层结构不能合并，原因见设计文档 2.3。
- 外层负责颜色渐变，`::before` 负责模糊和遮罩。
- 不新增颜色 token，不写产品十六进制色；`#000` 只作为遮罩模板。
- 只写标准属性，不手写 `-webkit-`；Lightning CSS 会按目标浏览器自动补前缀。
- 不加动画、`will-change` 或滚动监听。

完成后验证：

```bash
pnpm --filter @rakazo/web check
pnpm exec biome check apps/web/src/pages/shell/chat/chat-top-fade.tsx \
  apps/web/src/pages/shell/chat/chat-top-fade.css
```

完成标准：

- CSS 能被 Vite 解析并打包。
- 组件没有 props、没有状态、没有副作用。
- 文件行数远低于 1,000 行。

### Step 3：接入对话列并固定层级

目的：把遮罩放在滚动内容和头部之间，不改变现有交互。

文件：

- `apps/web/src/pages/Shell.tsx`
- `apps/web/src/pages/shell/chat/chat-header.tsx`（仅加测试标识）
- `apps/web/src/pages/shell/chat/chat-top-fade.tsx`（已新增）

改动 1：在 `Shell.tsx` 引入并渲染：

```tsx
import { ChatTopFade } from "./shell/chat/chat-top-fade";
```

```tsx
<div ref={chatColumnRef} ...>
  {/* Only the pills take input; the gaps pass clicks and scrolling to the transcript. */}
  <div aria-hidden="true" className="app-drag absolute inset-x-0 top-0 z-10 h-3" />
  <ChatTopFade />
  {findOpen ? (
    <div className="absolute end-3 top-14 z-20">
      <ChatFindBar ... />
    </div>
  ) : null}
  <ChatHeader ... />
  ...
</div>
```

改动 2：给头部外层加测试标识，便于 E2E 断言层级：

```tsx
<div
  data-testid="chat-header"
  className="pointer-events-none absolute inset-x-0 top-0 z-10 grid ..."
>
```

层级检查：

| 元素          | z-index | 期望           |
| ------------- | ------- | -------------- |
| `ChatTopFade` | 5       | 在滚动内容之上 |
| `ChatHeader`  | 10      | 在遮罩之上     |
| 搜索条、侧栏  | 20      | 不受影响       |
| 输入区        | 30      | 不受影响       |

完成后验证：

- 头部按钮仍可点击，胶囊之间的空隙仍能把滚轮和点击传给对话。
- 搜索条展开时仍在遮罩之上。
- 顶部 12px 拖拽条仍可拖动 Electron 窗口。

完成标准：

- `ChatTopFade` 的 `pointer-events` 为 `none`，`aria-hidden` 为 `true`。
- 没有改变 `ChatHeader` 的 DOM 结构和按钮顺序。
- 没有新增用户可见文案。

### Step 4：补充 E2E 断言与截图

目的：把“遮罩高度与留白一致、静止不压暗、滚动时生效、头部在上、事件穿透”
变成可重复的检查。

文件：`apps/web/e2e/chat/chat-header.spec.ts`。

在现有测试中补充：

1. 遮罩可见，且与对话列同宽、同起点：

```ts
const fade = page.getByTestId("chat-top-fade");
await expect(fade).toBeVisible();

const boxes = await page.evaluate(() => {
  const fade = document.querySelector('[data-testid="chat-top-fade"]')!;
  const transcript = document.querySelector('[data-testid="transcript"]')!;
  const header = document.querySelector('[data-testid="chat-header"]')!;
  const fadeRect = fade.getBoundingClientRect();
  const transcriptRect = transcript.getBoundingClientRect();
  return {
    fadeHeight: fadeRect.height,
    transcriptPadding: parseFloat(getComputedStyle(transcript).paddingTop),
    transcriptScrollPadding: parseFloat(getComputedStyle(transcript).scrollPaddingTop),
    transcriptTop: transcriptRect.top,
    fadeTop: fadeRect.top,
    transcriptLeft: transcriptRect.left,
    fadeLeft: fadeRect.left,
    transcriptWidth: transcriptRect.width,
    fadeWidth: fadeRect.width,
    fadeZ: getComputedStyle(fade).zIndex,
    headerZ: getComputedStyle(header).zIndex,
  };
});

expect(Math.abs(boxes.fadeHeight - boxes.transcriptPadding)).toBeLessThanOrEqual(1);
expect(boxes.transcriptScrollPadding).toBe(boxes.transcriptPadding);
expect(boxes.fadeTop).toBe(boxes.transcriptTop);
expect(boxes.fadeLeft).toBe(boxes.transcriptLeft);
expect(Math.abs(boxes.fadeWidth - boxes.transcriptWidth)).toBeLessThanOrEqual(1);
expect(Number(boxes.headerZ)).toBeGreaterThan(Number(boxes.fadeZ));
```

2. 模糊与遮罩确实生效：

```ts
const effect = await fade.evaluate((element) => {
  const before = getComputedStyle(element, "::before");
  return {
    filter: before.backdropFilter,
    mask: before.maskImage,
  };
});

expect(effect.filter).toContain("blur(20px)");
expect(effect.mask).toContain("linear-gradient");
```

3. 滚动后顶部内容进入遮罩，截图保留明暗两套：

```ts
await transcript.evaluate((element) => {
  element.scrollTop = element.scrollHeight;
});

for (const theme of ["light", "dark"]) {
  await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
  await captureScreenshot(page, testInfo, `chat-header-floating-${theme}`);
}
```

4. 回到顶部后首条消息不在遮罩内：

```ts
await transcript.evaluate((element) => {
  element.scrollTop = 0;
});

const first = await transcript
  .getByText(/^Question 1:/)
  .first()
  .boundingBox();
const fadeRect = await fade.boundingBox();
if (!first || !fadeRect) throw new Error("missing chat layout");
expect(first.y).toBeGreaterThanOrEqual(fadeRect.y + fadeRect.height - 1);
```

5. 窄屏留白仍是 80px：

```ts
await page.setViewportSize({ width: 390, height: 844 });
const narrow = await page.evaluate(() => {
  const transcript = document.querySelector('[data-testid="transcript"]')!;
  const fade = document.querySelector('[data-testid="chat-top-fade"]')!;
  return {
    padding: parseFloat(getComputedStyle(transcript).paddingTop),
    scrollPadding: parseFloat(getComputedStyle(transcript).scrollPaddingTop),
    fadeHeight: fade.getBoundingClientRect().height,
  };
});

expect(narrow.padding).toBe(80);
expect(narrow.scrollPadding).toBe(narrow.padding);
expect(narrow.fadeHeight).toBe(80);
```

截图约定：

- `chat-header-floating-light.png`
- `chat-header-floating-dark.png`
- 两张都在滚动状态下截取，能看出顶部渐隐与模糊。
- 如需证明静止不压暗，再补 `chat-header-floating-{theme}-rest.png`。

注意：

- `chat-header.spec.ts` 属于 nightly 套件，PR CI 默认跳过。
- 本地不要跑全量 Web E2E。若必须做单点排查，只跑这个 spec：

```bash
pnpm test:e2e -- --spec=chat/chat-header.spec.ts
```

完成标准：

- 新增断言在本地或 nightly 中通过。
- 明暗两套截图能看出效果。
- 现有“头部间隙命中 transcript”的断言仍通过。

### Step 5：全量验证

按顺序执行：

```bash
pnpm exec biome check --write \
  apps/web/src/pages/Shell.tsx \
  apps/web/src/pages/shell/chat/chat-header.tsx \
  apps/web/src/pages/shell/chat/chat-top-fade.tsx \
  apps/web/src/pages/shell/chat/chat-top-fade.css \
  apps/web/src/pages/shell/chat/transcript.tsx \
  apps/web/e2e/chat/chat-header.spec.ts

pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web test
pnpm checks
```

如果改动涉及启动 CSS 体积，再跑生产构建与预算检查：

```bash
pnpm build
node scripts/checks/bundle-size.mjs
```

说明：

- `pnpm checks` 必须在 push 前通过。
- `bundle-size` 需要构建产物；本次只增加很小的 CSS，正常不会触顶，但应以实际输出为准。
- 不运行 `intl:extract`，不修改 `messages.po`。
- 不运行桌面 Playwright 全量套件；它会在 macOS 抢占焦点，留给 CI。

完成标准：

- 上述命令全部通过，或失败项已确认是基线已有且与本改动无关。

### Step 6：提交 PR、CI 与截图

PR 约定：

- 一个 PR 只做这一件事。
- 不编辑 `CHANGELOG.md`。
- 不改翻译目录。
- 描述包含 `## What`、`## Why`、`## Changes`、`## Tested`；有风险时再加
  `## Risk`。
- 没有新增用户可见文案，因此不需要引用文案。

截图：

1. 触发 nightly Playwright（`nightly verification` 的 `workflow_dispatch`，
   或等待每日 02:23 UTC 的定时任务）。
2. 从产物中取 `chat-header-floating-light.png` 与
   `chat-header-floating-dark.png`。
3. 附在 PR 描述里，说明它们是滚动状态下的顶部渐隐效果。

CI 与 review：

- 按 `pr-watch` 等待检查与 review bot。
- 每个可执行的 finding 处理后再 push。
- review bot 仍 pending 或有未解决项时不要合并。
- Vercel 在 fork PR 上的 “Authorization required to deploy” 忽略。

完成标准：

- 必需检查通过。
- 截图已附。
- 没有未解决的 review 反馈。

## 4. 验收标准

### A. 功能与视觉

| ID    | 验收标准                                                               | 验证方式                                                   | 证据                                            |
| ----- | ---------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| AC-01 | 遮罩只在对话列内，起点和宽度与滚动容器一致，不覆盖侧栏、侧面板或输入区 | E2E 几何断言                                               | `fade` 与 `transcript` 的 `top`/`left`/宽度一致 |
| AC-02 | 1280px 下遮罩高度、内容顶部留白、滚动对齐都是 84px（±1px）             | E2E 比较 `fadeHeight`、`paddingTop`、`scrollPaddingTop`    | 断言通过                                        |
| AC-03 | 390px 下遮罩高度、内容顶部留白、滚动对齐都是 80px                      | E2E 窄屏断言                                               | 断言通过                                        |
| AC-04 | 静止在 `scrollTop = 0` 时，第一条消息顶部不低于遮罩底部                | E2E 首条消息与 `fadeRect` 比较                             | 断言通过 + 截图                                 |
| AC-05 | 滚动后顶部内容出现渐隐与模糊，过渡没有硬边                             | 明暗两套截图                                               | `chat-header-floating-{light,dark}.png`         |
| AC-06 | 头部胶囊、按钮、拖拽条在遮罩之上，保持清晰                             | E2E `headerZ > fadeZ` + 截图                               | 断言通过 + 截图                                 |
| AC-07 | 遮罩的模糊为 20px，遮罩图为纵向渐变                                    | E2E 读取 `::before.backdropFilter` 与 `::before.maskImage` | 断言通过                                        |
| AC-08 | 点击、滚轮、文本选择仍落到对话内容上                                   | 现有 `elementFromPoint` 断言 + 手动滚轮                    | 断言通过                                        |
| AC-09 | 不产生布局位移：头部仍在顶部，滚动容器起点不变                         | E2E 几何断言                                               | 断言通过                                        |
| AC-10 | 明暗主题都使用 `--background`，没有硬编码产品色                        | 代码审查 + 明暗截图                                        | diff 与截图                                     |

### B. 降级与性能

| ID    | 验收标准                                                  | 验证方式                                      | 证据                                 |
| ----- | --------------------------------------------------------- | --------------------------------------------- | ------------------------------------ |
| AC-11 | macOS“降低透明度”开启时模糊关闭、渐变保留                 | 手动：系统设置 → 辅助功能 → 显示 → 降低透明度 | 手动记录；不要求自动化               |
| AC-12 | 浏览器不支持 `backdrop-filter` 时仍有基础渐变，不出现硬边 | DevTools 临时禁用该属性                       | 手动记录                             |
| AC-13 | 不新增动画，`prefers-reduced-motion` 下行为不变           | 代码审查                                      | CSS 无 animation/transition          |
| AC-14 | 正常滚动时不出现明显掉帧                                  | 在 1280×800 Chromium 下滚动长对话             | 手动观察；必要时看 Performance 面板  |
| AC-15 | 若窄屏 Web 掉帧，可退化为窄屏只保留渐变                   | 代码审查退路                                  | 设计文档 5.6；实现时默认不预置该分支 |

### C. 回归

| ID    | 验收标准                                     | 验证方式                                                        | 证据            |
| ----- | -------------------------------------------- | --------------------------------------------------------------- | --------------- |
| AC-16 | 头部按钮仍可点击，面板、通话、邀请等行为不变 | 现有 E2E + 手动点击                                             | 现有测试通过    |
| AC-17 | 搜索条展开时不被遮罩压暗或挡住               | 手动打开搜索                                                    | 手动记录        |
| AC-18 | 输入区、队列消息、通话卡片层级不变           | 代码审查 + 手动                                                 | diff 只增加遮罩 |
| AC-19 | 移动端原生对话不发生变化                     | `git diff -- apps/mobile` 为空                                  | diff            |
| AC-20 | 没有新增或修改用户可见文案                   | `git diff` 不含 `messages.po`；新增的 `.tsx` 没有用户可见字符串 | diff            |

### D. 工程质量

| ID    | 验收标准                                            | 验证方式                                            |
| ----- | --------------------------------------------------- | --------------------------------------------------- |
| AC-21 | TypeScript 通过                                     | `pnpm --filter @rakazo/web check`                   |
| AC-22 | Web 单元/组件测试通过                               | `pnpm --filter @rakazo/web test`                    |
| AC-23 | 仓库检查通过                                        | `pnpm checks`                                       |
| AC-24 | Biome 格式与 lint 通过                              | `pnpm exec biome check`（changed files）            |
| AC-25 | 生产构建与启动体积预算通过                          | `pnpm build && node scripts/checks/bundle-size.mjs` |
| AC-26 | 新文件不超过 1,000 行；`chat` 目录代码文件不超过 40 | `pnpm checks`                                       |
| AC-27 | 没有新增依赖                                        | `git diff -- package.json pnpm-lock.yaml` 为空      |

### E. PR 与评审

| ID    | 验收标准                                         | 验证方式               |
| ----- | ------------------------------------------------ | ---------------------- |
| AC-28 | 一个 PR 只包含本功能                             | PR diff                |
| AC-29 | PR 描述包含 What / Why / Changes / Tested        | PR 描述                |
| AC-30 | 明暗两套 CI 截图已附                             | PR 描述                |
| AC-31 | 没有编辑 `CHANGELOG.md`                          | PR diff                |
| AC-32 | 没有编辑翻译目录                                 | PR diff                |
| AC-33 | CI 必需检查通过，review bot 已结束且无未解决项   | PR 检查页 + `pr-watch` |
| AC-34 | 可回滚：只回退本 PR 的代码即可恢复，无数据副作用 | PR diff 只含前端文件   |

## 5. 测试矩阵

| 层         | 覆盖内容                                    | 何时运行              | 备注                              |
| ---------- | ------------------------------------------- | --------------------- | --------------------------------- |
| TypeScript | 新组件、Shell 接入、E2E 类型                | 每次改动后            | `pnpm --filter @rakazo/web check` |
| 单元/组件  | 现有 Web 测试回归                           | 每次改动后            | `pnpm --filter @rakazo/web test`  |
| 仓库检查   | 目录大小、行数、导入边界                    | push 前               | `pnpm checks`                     |
| Web E2E    | 遮罩几何、层级、命中、截图                  | nightly / 手动单 spec | `chat-header.spec.ts`             |
| 手动       | 降低透明度、无 backdrop 支持、Electron 拖动 | 实现完成后一次        | 记录在 PR 的 Tested               |
| 构建       | CSS 打包、启动体积                          | 本地可选，CI 必跑     | `pnpm build`                      |

## 6. 风险与应对

| 风险                       | 触发信号                 | 应对                                                                           |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| 窄屏 Web 滚动掉帧          | 手机上快速滚动明显卡顿   | 只对 `md` 及以上启用模糊，窄屏保留渐变；不改结构                               |
| 磨砂胶囊叠加后发灰         | 明暗截图中胶囊边缘浑浊   | 先确认是遮罩导致；只调整遮罩的渐变/模糊，不改共享 `Button` 变体                |
| 变量未继承导致留白为 0     | computed padding 变成 0  | 确认变量声明在 `chatColumnRef` 上，且与 `pt-(--chat-top-clearance)` 同一次提交 |
| 遮罩盖住搜索条或侧栏       | 搜索条变暗、点击不到     | 检查 `z-[5]` 与 `z-20`；遮罩只应放在对话列内                                   |
| nightly 截图拿不到         | PR CI 没有 `chat-header` | 手动 dispatch `nightly verification`，或等待每日定时任务                       |
| 旧浏览器不支持 `color-mix` | 渐变声明被忽略           | 第一条纯 `var(--background)` → `transparent` 的兜底仍在                        |

回滚：

- 本改动只涉及 Web 前端文件，无数据库、无契约、无外部副作用。
- 出问题时直接 revert 整个 PR；移动端和桌面端其他功能不受影响。

## 7. 预计工作量

| 步骤              | 预计                 |
| ----------------- | -------------------- |
| Step 0 基线       | 15 分钟              |
| Step 1 留白变量   | 20 分钟              |
| Step 2 组件与样式 | 30 分钟              |
| Step 3 接入与层级 | 20 分钟              |
| Step 4 E2E 与截图 | 45 分钟              |
| Step 5 全量验证   | 30 分钟              |
| Step 6 PR 与 CI   | 30–60 分钟（含等待） |
| 合计              | 约 3–4 小时          |

## 8. 执行清单

- [ ] Step 0：记录基线，确认没有冲突改动。
- [ ] Step 1：对话列声明 `--chat-top-clearance`，`Transcript` 的留白与滚动对齐改用该变量。
- [ ] Step 1：1280 / 390 两个断点的 computed padding 与 scroll padding 正确。
- [ ] Step 2：新增 `chat-top-fade.tsx` 与 `chat-top-fade.css`。
- [ ] Step 3：`Shell.tsx` 渲染 `<ChatTopFade />`，头部加 `data-testid`。
- [ ] Step 3：确认遮罩 `pointer-events-none`、`aria-hidden`、`z-[5]`。
- [ ] Step 4：补充 E2E 几何、层级、模糊、静止、窄屏断言。
- [ ] Step 4：更新明暗两套截图。
- [ ] Step 5：Biome、typecheck、Web test、`pnpm checks` 全部通过。
- [ ] Step 5：构建与 bundle budget 通过。
- [ ] Step 6：触发 nightly，拿到截图。
- [ ] Step 6：按模板写 PR 描述并附截图。
- [ ] Step 6：`pr-watch` 跟到 checks 与 review 结束。
