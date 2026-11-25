# Rakazo 电脑体验执行计划

Status: Ready to execute

Design reference: [computer-experience-architecture.md](./computer-experience-architecture.md)

## 0.1 进度

| 任务   | 状态   | 证据                                                                                          |
| ------ | ------ | --------------------------------------------------------------------------------------------- |
| P1-01  | 已完成 | 契约新增 target/element/window/find/settle/zoom/capabilities；旧 provider 不需要实现也能编译  |
| P1-02  | 已完成 | `fake-perception.test.ts` 13 个用例                                                           |
| P1-03  | 已完成 | `test_atspi.py` 12 个用例                                                                     |
| P1-04  | 已完成 | Dockerfile 安装 AT-SPI，`start.sh` 起 bus 与 helper，CI 跑 Python 用例                        |
| P1-05  | 已完成 | `linux-desktop.ts` 接 `AtspiPerception`；docker/createos/wuying/fake 全部转发                 |
| P1-06  | 已完成 | `computer-tools.test.ts` 覆盖目标消失、移动、旧 frame、坐标 fallback                          |
| P1-07  | 已完成 | 新增 `computer_find`、`computer_zoom`、`computer_settle`；`computer_act` 支持 target          |
| P1-08  | 已完成 | `run-instructions.prompt.ts` 原生应用优先 target、页面优先 `browser_snapshot`                |
| P1-09  | 已完成 | `computer-overlay.test.tsx` 6 个用例；Find/Zoom 走 `useSave`                                  |
| P1-10  | 已完成 | `use-computer-finder.ts`、`ComputerFindSheet`、`ComputerZoomModal`；`computer.tsx` 963 行      |
| P1-11  | 已完成 | `computer-perception.docker.test.ts` 3 个用例，`pnpm test:computer-replay` 7 个全绿            |
| P1-12  | 已完成 | `computer-runtime.md` 新增语义感知一节，`computer.md` 新增查找控件一节                        |

## 0. 使用方式

这份计划是执行清单，不是设计说明。每个任务都写清楚：

- 做什么。
- 改哪些文件。
- 依赖哪个任务。
- 怎么验证。
- 什么算完成。
- 怎么回滚。

执行时按 Phase 1 的 PR 顺序推进。每个 PR 只做一件事，不把串流、桌面应用、录制混进语义感知。

## 1. 完成定义

一个任务只有同时满足以下条件才算完成：

- 代码通过 `pnpm check`、`pnpm lint`、`pnpm checks`。
- 新增或修改的测试通过。
- 旧 provider、旧镜像、没有 AT-SPI 的环境可以安全降级。
- 没有把 vendor 名称写进共享 contracts、设置、数据库列、路由或 UI。
- 没有提交 secrets、`.env`、私有 URL、个人数据。
- PR 描述包含 `## What`、`## Why`、`## Changes`、`## Tested`。
- UI 改动附截图；没有截图时说明原因。
- 文档和提示词同步更新。

## 1.1 验收标准总表

验收分三层：全局验收、Phase 1 场景验收、每个任务的证据。任何一层不通过，Phase 1 不算完成。

### A. 全局验收

| 项             | 通过条件                                                      | 证据                 |
| -------------- | ------------------------------------------------------------- | -------------------- |
| 构建           | `pnpm check`、`pnpm lint`、`pnpm checks` 全绿                 | CI                   |
| 单测           | 新增和修改的测试全绿                                          | CI                   |
| 旧镜像         | 没有 AT-SPI 时 `computer_find` 返回 `unknown`，坐标路径仍可用 | Docker 集成测试      |
| 旧 provider    | 没有实现新方法的 provider 仍可编译、可运行                    | 类型检查、单测       |
| 旧 observation | 原有 image、cursor、activeWindow 字段不变                     | 回归测试             |
| 安全           | 不读元素 value；密码 mask；日志 redact                        | 单测、人工 review    |
| 多 display     | 每个 bot 只看到自己的窗口                                     | 多 display 测试      |
| UI             | 有截图；没有 raw id；没有硬编码颜色或高度 class               | PR 截图、review      |
| 文档           | `computer-runtime.md` 和 `computer.md` 已更新                 | PR                   |
| 公开仓库       | 没有 secrets、`.env`、私有 URL、个人数据                      | `git status`、review |

### B. Phase 1 场景验收

| ID  | Given                      | When                                         | Then                                                    | 证据            |
| --- | -------------------------- | -------------------------------------------- | ------------------------------------------------------- | --------------- |
| A1  | Docker 电脑打开 `mousepad` | `computer_find(text="Save")`                 | 返回 `role=button`、`name=Save` 的元素，bounds 在窗口内 | Docker 集成     |
| A2  | A1 的 frameId              | `computer_act(target=Save, basedOn=frameId)` | 保存成功，返回新的 observation                          | Docker 集成     |
| A3  | Docker 电脑打开 `thunar`   | `computer_find(text="Home")`                 | 返回 Home 元素，点击后进入 home                         | Docker 集成     |
| A4  | 两个 bot、两个 display     | bot A 调 `computer_find`                     | 只返回 A 的窗口，不返回 B 的窗口                        | 多 display 测试 |
| A5  | 目标移动或窗口关闭         | 用旧 target 调 `computer_act`                | 返回 `stale`，不执行点击                                | 单测            |
| A6  | 旧镜像没有 AT-SPI          | 调 `computer_find`                           | 返回 `unknown`，不抛未处理错误                          | Docker 集成     |
| A7  | 应用挂起                   | 调 `computer_find`                           | 在 deadline 内返回 `unknown`，输入不被阻塞              | 超时测试        |
| A8  | 页面打开                   | 调 `browser_snapshot`                        | 现有行为不变，refs 仍可点击                             | 回归测试        |
| A9  | 用户持有控制               | 调 `computer_act`                            | 等待或拒绝，不会抢输入                                  | 现有控制测试    |
| A10 | 目标有 secret 字段         | `computer_observe` / `computer_find`         | 不返回 value，只返回 masked 状态                        | 安全单测        |
| A11 | 100 次 find 调用           | 连续执行                                     | 内存不增长，helper 不残留                               | 压力测试        |
| A12 | 旧 provider                | 调新工具                                     | 返回明确“不支持”，不是崩溃                              | 单测            |

### C. 每任务证据

| 任务          | 必须提交的证据                   | 通过条件                                                    |
| ------------- | -------------------------------- | ----------------------------------------------------------- |
| P1-01 契约    | 类型 diff、契约单测              | 旧 provider 不需要实现新方法也能编译                        |
| P1-02 Fake    | fake perception 单测             | 精确、前缀、role、`unknown`、`truncated` 全覆盖             |
| P1-03 helper  | `test_atspi.py`、helper 健康检查 | deadline、裁剪、display 过滤通过                            |
| P1-04 镜像    | 镜像构建日志、健康检查           | AT-SPI 可用；没有 AT-SPI 时返回 `unknown`                   |
| P1-05 adapter | adapter 单测、Docker 集成        | `findElements`、`settle`、`zoom` 可用；旧 provider fallback |
| P1-06 target  | target 单测                      | 目标消失、移动、旧 frame、坐标 fallback 全覆盖              |
| P1-07 工具    | 工具定义快照、handler 测试       | 新工具可调用；旧工具行为不变                                |
| P1-08 提示词  | prompt 快照                      | 原生应用优先 target；页面优先 browser；cache prefix 稳定    |
| P1-09 Web     | Web 测试、截图                   | Find、Zoom 可用；无 raw id；不抢焦点                        |
| P1-10 Mobile  | Mobile 测试、截图                | 原生控件；键盘条、tabletop 不回归                           |
| P1-11 Docker  | `pnpm test:computer-replay`      | A1 到 A7 全部通过                                           |
| P1-12 文档    | PR 描述、截图、文档 diff         | 文档和代码一致；PR 描述完整                                 |

### D. 非功能验收

| 项       | 目标                                                            | 测量方式              |
| -------- | --------------------------------------------------------------- | --------------------- |
| 感知延迟 | `computer_find` p95 小于 1 秒，300 个元素以内                   | Docker 测试机器上测量 |
| 输入延迟 | target 解析加点击小于 3 秒                                      | Docker 测试机器上测量 |
| 内存     | 连续 100 次调用后 helper 内存不持续增长                         | 压测                  |
| 元素上限 | 最多 300 个元素，深度 40，名称 256 字符                         | 单测                  |
| 安全     | 不读 value；secret mask；日志无页面文本                         | 单测、review          |
| 可观测   | timeout、unknown、stale、settle、stream、recording 有日志和指标 | 日志快照              |
| 可访问性 | 新控件有可访问名称；键盘可达                                    | Web/Mobile 测试       |
| 兼容性   | 旧镜像、旧 provider、无 DB 迁移                                 | 回归测试              |

### E. 不通过的情况

以下任一情况出现，Phase 1 不通过：

- 目标已经失效，仍然执行点击。
- 旧镜像没有 AT-SPI 时抛未处理错误，而不是 `unknown`。
- 多 display 下 bot A 能看到或操作 bot B 的窗口。
- 日志、工具结果或 UI 出现元素 value、secret、页面文本。
- 提示词每次运行都变化，破坏 cached prefix。
- 没有测试、没有截图、没有文档更新。
- 为了新功能破坏现有 `browser_snapshot`、takeover、keyboard bar 或 tabletop。

### F. Phase 1 出口条件

- P1-01 到 P1-12 全部完成。
- A 到 E 全部通过。
- 6 个 PR 全部合并。
- `pnpm checks`、`pnpm lint`、`pnpm check` 全绿。
- Docker replay、Web、Mobile、Python helper 测试全绿。
- 文档、截图、PR 描述齐全。

### G. Phase 2 到 4 的验收口径

- Phase 2：VNC 和 WebRTC 可切换；60fps 目标；断线重连；VNC fallback。
- Phase 3：能打开 xlsx/docx/pptx、编辑图片、打开代码仓库；capabilities 能指导模型选择 surface。
- Phase 4：能录制、回放、导出；用户控制区间有 gap；不包含 secret；存储有上限。

## 1.2 防跑偏控制

计划足够开始，但还需要明确“什么不能做”和“什么时候停下来重新规划”。这一节就是防跑偏的闸门。

### A. 范围围栏

Phase 1 只做语义感知。以下明确不在 Phase 1：

- 串流、桌面应用、录制回放。
- page-browser、agent-browser、CDP 浏览器栈。
- Wuying、host desktop、CUA。
- 数据库 schema 或 migration。
- 新依赖、新环境变量、新 vendor。
- 新公共工具名以外的 UI 文案。
- 新的 provider 分支或 provider-specific 行为。

任何一项要进 Phase 1，先更新本计划，再单独开 PR。

### B. 接口冻结

P1-01 合并后，以下类型冻结：

- `ComputerTarget`
- `ComputerElement`
- `ComputerWindow`
- `ComputerFindRequest/Result`
- `ComputerSettleRequest/Result`
- `ComputerZoomRequest`
- `ComputerCapabilities`
- `ComputerAction` 的新字段

后续只能加可选字段，不能改名、不能改语义、不能删字段。需要破坏性变更时，先写 ADR，再改计划。

### C. 决策日志

| 决策              | 默认                               | 重新打开的条件                |
| ----------------- | ---------------------------------- | ----------------------------- |
| 多 display helper | 一个 helper 按 display 过滤        | 压测证明不可行，或跨 bot 泄漏 |
| settle            | Phase 1 截图 diff，Phase 2 XDamage | 截图 diff 超过 1 秒           |
| zoom              | 用 `librakazo-xcapture.so` 裁剪    | 现有 capture 无法稳定输出     |
| 串流              | VNC 默认，WebRTC 第二              | VNC 无法满足移动端            |
| 录制              | WebM 先，MP4 导出后                | 浏览器兼容或编码成本不可接受  |
| 桌面应用          | 单独 `computer-desktop` tag        | 镜像大小超出预算              |
| work context      | 新工具 `computer_capabilities`     | 与现有工具职责重叠            |

每次改默认，记录日期、证据和影响。没有新证据，不重新讨论。

### D. 里程碑门禁

| Gate   | 包含任务     | 通过条件                                   | 不通过时                  |
| ------ | ------------ | ------------------------------------------ | ------------------------- |
| Gate 1 | P1-01、P1-02 | 类型和单测通过，无行为变化                 | 停在契约层，不进入 helper |
| Gate 2 | P1-03、P1-04 | 镜像构建、helper 健康检查、Python 测试通过 | 不接 adapter              |
| Gate 3 | P1-05、P1-06 | target 单测通过，旧镜像 fallback           | 不接工具                  |
| Gate 4 | P1-07、P1-08 | 工具和 prompt 测试通过                     | 不接 UI                   |
| Gate 5 | P1-09、P1-10 | Web/Mobile 测试和截图通过                  | 不合并 Docker 集成        |
| Gate 6 | P1-11、P1-12 | Docker replay、文档、PR 描述通过           | 不开始 Phase 2            |

### E. 停止条件

出现以下任一情况，停止当前 PR，更新计划，再决定是否继续：

- 跨 bot 或跨 display 泄漏元素。
- Chromium 可访问性无法稳定启用。
- 镜像超过 2 GB，或构建超过 10 分钟。
- `computer_find` p95 超过 2 秒，且优化后仍不达标。
- 现有 `browser_snapshot`、takeover、keyboard bar 或 tabletop 回归。
- Phase 1 出现超过 2 个白名单外的新文件。
- 需要新依赖、新环境变量、新数据库列或新 provider。

### F. 漂移信号

PR 出现以下信号时，先问“这是不是 Phase 1 的范围”：

- 单 PR 超过 400 行（不含测试和生成文件）或超过 12 个文件。
- 新增计划外的公共类型、工具名、环境变量、依赖、数据库列或 provider。
- prompt 改动没有 eval 说明。
- UI 文案没有引用、没有截图、没有 `ux-declutter` review。
- 出现 provider-specific 分支。
- 测试数量减少。
- 镜像增加超过 300 MB。
- `pnpm checks` 失败。
- 计划外的新文件。

### G. Phase 1 文件白名单

| PR   | 允许修改                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR 1 | `packages/adapter-kit/src/types.ts`、`interfaces.ts`、`packages/contracts/src/computers/computer.ts`、`packages/adapters/src/computers/perception/*`、对应测试                                                                                                                       |
| PR 2 | `infra/sandboxes/computer/*`、`.github/workflows/test-suites.yml` 或 `computer-replay.yml`                                                                                                                                                                                           |
| PR 3 | `packages/adapters/src/computers/screens/linux-desktop.ts`、`computer-tools.ts`、`extra-displays.ts`、provider/decorator 文件、对应测试                                                                                                                                              |
| PR 4 | `packages/adapters/src/tools/builtin-computer.tool-definition.ts`、`runs/tools/run-tools-computer.ts`、`run-tool-selection.ts`、`builtin-tool-bridge.ts`、`context-pruning.ts`、`pi-runtime-tools.ts`、`model-vision.ts`、`release-watch.ts`、`run-instructions.prompt.ts`、对应测试 |
| PR 5 | `apps/web/src/pages/shell/computers/*`、`apps/mobile/app/computer.tsx`、`apps/mobile/components/computers/*`、对应测试                                                                                                                                                               |
| PR 6 | `packages/testkit/src/computers/*`、`docs/computer*.md`、workflow                                                                                                                                                                                                                    |

白名单外的文件，先更新计划，再改。

### H. 测试先行

- P1-01：先写契约测试。
- P1-03：先写 helper 纯函数测试。
- P1-06：先写 target 解析测试。
- P1-11：先写 Docker 场景。
- 性能任务先记录 baseline，再改代码。
- 每个 PR 记录 p50/p95、镜像大小、测试耗时。

### I. AT-SPI 熔断

- 熔断粒度：每台电脑、每个 display。
- 触发：连续 N 次超时或未知。
- 行为：`computer_find` 立即返回 `unknown`，坐标路径保持可用。
- 日志：`computer.perception.circuit_open`。
- 冷却后先健康检查，再恢复。
- 熔断期间不阻塞输入、shell、files。

### J. 安全威胁模型

- Team Computer 是共享安全边界，不是互不信任进程的边界。
- AT-SPI 是 session-wide 的，必须按 display 和 PID 过滤。
- 过滤失败时 fail closed，返回 `unknown`，不返回其他 bot 的元素。
- 只读 role/name/bounds/state，不读 value。
- name 也可能包含敏感文本，日志和 telemetry 必须 redact。
- 跨 bot 测试必须通过；不通过就停止发布。
- 需要强隔离时用 Private Computer。

### K. Provider 推进矩阵

| Provider     | Phase 1 | 验证                            |
| ------------ | ------- | ------------------------------- |
| Docker       | 是      | 主要开发与集成目标              |
| E2B          | 是      | 重建 template，验证 AT-SPI      |
| Daytona      | 是      | 同一镜像，验证 helper           |
| Boat         | 是      | 同一镜像，验证 helper           |
| Boxd         | 是      | 同一镜像，验证 helper           |
| Instabox     | 是      | 同一镜像，验证 helper           |
| Railway      | 是      | 同一镜像，验证 helper           |
| Kubernetes   | 是      | 同一镜像，验证 pod 内 helper    |
| Incus        | 是      | 同一镜像，验证容器内 helper     |
| local-vm     | 是      | Apple container 内验证 helper   |
| fake         | 是      | `FakePerception`                |
| Wuying       | 否      | Windows，继续用现有 MCP/OpenAPI |
| desktop/host | 否      | 继续用 CUA                      |
| none         | 否      | 没有电脑                        |

### L. 原生应用支持矩阵

| Toolkit         | Phase 1 | 说明                 |
| --------------- | ------- | -------------------- |
| GTK3/GTK4       | 支持    | 主要目标             |
| Qt              | 支持    | 通过 AT-SPI，需测试  |
| Chromium chrome | 支持    | AT-SPI；页面走 CDP   |
| Electron        | 支持    | AT-SPI + CDP，需测试 |
| LibreOffice     | Phase 3 | VCL 偏移需要单独验证 |
| Java/Swing      | 不保证  | 有时间再做           |
| Wayland         | 不支持  | Rakazo 使用 X11      |
| 游戏/canvas     | 坐标    | 不做语义保证         |

### M. 性能预算

- `computer_find` p95 小于 1 秒，300 个元素以内。
- target 解析加点击小于 3 秒。
- 连续 100 次调用后 helper 内存不持续增长。
- 基础镜像增加不超过 300 MB。
- computer-replay CI 不超过 15 分钟。

### N. 提示词与 UI 审查

- 任何 prompt 改动都要说明是否跑 eval；跑了给 before/after，不跑就明说。
- 新 UI 文案必须引用原文，解释为什么必要，并跑 `ux-declutter` 看截图。
- 文案不用 em dash 连接句子。
- 控件有可访问名称。
- 不把 raw id 展示到界面。

### O. 变更控制

- 计划是活文档，每个 Gate 后更新实际耗时、测试结果和风险。
- 新任务先更新计划，再开 PR。
- 新依赖、新环境变量、新数据库列、新 provider 单独 PR。
- 破坏性契约变更先写 ADR。
- 不在 Phase 1 里顺手做 Phase 2 到 4 的事。

## 2. 依赖图

```text
P1-01 契约
  -> P1-02 Fake perception
  -> P1-03 AT-SPI helper
       -> P1-04 镜像与启动
            -> P1-05 Linux adapter
                 -> P1-06 target 解析
                      -> P1-07 工具定义与 handler
                           -> P1-08 提示词
                           -> P1-09 Web UI
                           -> P1-10 Mobile UI
                                -> P1-11 Docker 集成
                                     -> P1-12 文档与截图
```

可以并行的部分：

- P1-02 和 P1-03 可以在 P1-01 之后并行。
- P1-09 和 P1-10 可以在 P1-07 的 schema 稳定后并行。
- P1-11 必须等 P1-04 和 P1-05 完成。

## 3. Phase 1 任务表

| ID    | 任务                   | 主要文件                                                        | 依赖  | 验证                         | 估算   |
| ----- | ---------------------- | --------------------------------------------------------------- | ----- | ---------------------------- | ------ |
| P1-01 | 新增电脑感知契约       | `packages/adapter-kit/src/types.ts`、`interfaces.ts`            | 无    | 类型检查、契约单测           | 0.5 天 |
| P1-02 | 新增 Fake perception   | `packages/adapters/src/computers/perception/fake-perception.ts` | P1-01 | 单测                         | 0.5 天 |
| P1-03 | 新增 AT-SPI helper     | `infra/sandboxes/computer/atspi.py`                             | P1-01 | Python 单测、Docker 健康检查 | 1.5 天 |
| P1-04 | 镜像和启动接入         | `Dockerfile`、`start.sh`、`rakazo-perception`                   | P1-03 | 镜像构建、健康检查           | 0.5 天 |
| P1-05 | Linux adapter 接入感知 | `linux-desktop.ts`、`perception/*`                              | P1-04 | 单测、Docker 集成            | 1 天   |
| P1-06 | target 解析与新鲜度    | `computer-tools.ts`、`extra-displays.ts`                        | P1-05 | 单测                         | 0.5 天 |
| P1-07 | 工具定义与 handler     | `builtin-computer.tool-definition.ts`、`run-tools-computer.ts`  | P1-06 | 工具测试                     | 1 天   |
| P1-08 | 提示词                 | `run-instructions.prompt.ts`、`pi-runtime-tools.ts`             | P1-07 | prompt 快照                  | 0.5 天 |
| P1-09 | Web UI                 | `apps/web/src/pages/shell/computers/*`                          | P1-07 | Web 测试、截图               | 1 天   |
| P1-10 | Mobile UI              | `apps/mobile/app/computer.tsx`                                  | P1-07 | Mobile 测试、截图            | 1 天   |
| P1-11 | Docker 集成            | `packages/testkit/src/computers/*`                              | P1-05 | `pnpm test:computer-replay`  | 1 天   |
| P1-12 | 文档与 PR              | `docs/computer*.md`                                             | P1-11 | 人工 review                  | 0.5 天 |

总计：约 9 人日。多 display 和 Chromium 可访问性如果遇到问题，会额外增加 1 到 2 天。

## 4. Phase 1 详细任务

### P1-01 新增电脑感知契约

**目标**

只加类型和可选接口，不改行为，不切默认。

**文件**

- `packages/adapter-kit/src/types.ts`
- `packages/adapter-kit/src/interfaces.ts`
- `packages/contracts/src/computers/computer.ts`

**步骤**

1. 在 `types.ts` 新增：
   - `ComputerRect`
   - `ComputerTarget`
   - `ComputerElement`
   - `ComputerWindow`
   - `ComputerFindRequest`
   - `ComputerFindResult`
   - `ComputerSettleRequest`
   - `ComputerSettleResult`
   - `ComputerZoomRequest`
   - `ComputerCapabilities`
2. 扩展 `ComputerObservation`：
   - 可选 `pointer?: { x: number; y: number }`
   - 可选 `windows?: ComputerWindow[]`
   - 可选 `elements?: ComputerElement[]`
3. 扩展 `ComputerAction`：
   - `target?: ComputerTarget`
   - `basedOn?: string`
   - 新增 `drag`、`zoom`、`settle`
4. 扩展 `SandboxKindCapabilities`：
   - `perception?: { atspi; cdp; hitTest; settle; zoom }`
   - `stream?: { protocol: "vnc" | "webrtc"; quality: boolean }`
   - `recording?: boolean`
   - `desktopApps?: boolean`
5. 在 `SandboxProvider` 增加可选方法：
   - `findElements?`
   - `settle?`
   - `zoom?`
   - `capabilities?`
6. 在 `ComputerStatusSchema` 增加可选能力字段，保持向后兼容。

**验证**

```bash
pnpm exec vitest run packages/adapters/src/computers/screens/computer-tools.test.ts
pnpm check
```

**完成标准**

- 旧 provider 不需要实现新方法也能编译。
- 旧 observation 和 action 的 wire shape 不变。
- 没有新增必填字段。

**回滚**

纯类型改动，回滚 PR 即可；没有数据迁移。

### P1-02 新增 Fake perception

**目标**

给 `ComputerPerception` 提供一个确定性的 fake，测试 target 解析、`unknown` 和 `truncated`。

**文件**

- `packages/adapters/src/computers/perception/perception.ts`
- `packages/adapters/src/computers/perception/fake-perception.ts`
- `packages/adapters/src/computers/perception/fake-perception.test.ts`

**步骤**

1. 定义 `ComputerPerception` interface：
   - `observe`
   - `find`
   - `hitTest`
   - `focused`
   - `zoom`
   - `capabilities`
2. 实现 `FakePerception`：
   - 固定窗口树。
   - 固定元素 role/name/bounds。
   - 可配置 `unknown`、`truncated`、超时。
3. 测试：
   - 精确匹配。
   - 前缀匹配。
   - role 过滤。
   - 超时返回 `unknown`。
   - 超过 limit 返回 `truncated`。

**验证**

```bash
pnpm exec vitest run packages/adapters/src/computers/perception
```

**完成标准**

- fake 不启动进程。
- 不依赖 Docker。
- 测试可在毫秒级完成。

### P1-03 新增 AT-SPI helper

**目标**

在电脑镜像里提供一个持久 AT-SPI helper，按 display 查询窗口、元素、hit-test 和 focused element。

**文件**

- `infra/sandboxes/computer/atspi.py`
- `infra/sandboxes/computer/test_atspi.py`
- `infra/sandboxes/computer/rakazo-perception`

**步骤**

1. `atspi.py` 使用 `gi.repository.Atspi`。
2. helper 通过 Unix socket 接收 JSON lines：
   - `health`
   - `windows`
   - `tree`
   - `find`
   - `at`
   - `focused`
   - `capabilities`
   - `shutdown`
3. 每个请求带 `display` 和 `deadline`。
4. display 过滤：
   - `DISPLAY=:N wmctrl -lxp` 拿窗口 id、PID、class、title、frame。
   - 只遍历 PID 命中的 AT-SPI app。
   - 元素 extents 映射到 device pixels，再裁剪到窗口 frame。
5. 限制：
   - `SCAN_LIMIT`
   - `WALK_CHILD_LIMIT`
   - `DEPTH_LIMIT`
   - `TREE_LIMIT`
   - 名称最大 256。
6. 超时返回 `{ "unknown": true }`，不返回部分结果。
7. `rakazo-perception` 是 CLI 包装：
   - 读 stdin JSON。
   - 连接 `/tmp/rakazo/perception.sock`。
   - 写 stdout JSON。
   - 连接失败时返回 `unknown`。
8. `test_atspi.py` 用 fake `gi` 模块测纯函数：
   - 角色匹配。
   - 名称裁剪。
   - extents 映射。
   - deadline。
   - JSON 协议。

**验证**

```bash
python3 infra/sandboxes/computer/test_atspi.py
pnpm sandbox:build
docker run --rm rakazo/computer:local rakazo-perception <<< '{"cmd":"health"}'
```

**完成标准**

- helper 不在请求线程里阻塞输入。
- 超时和未知有明确语义。
- 名称和元素数有上限。
- 没有读取元素的 value。

**回滚**

helper 是新增文件，不影响旧路径。镜像回退到旧 tag 即可。

### P1-04 镜像和启动接入

**目标**

让 AT-SPI bus 和 helper 在电脑启动时可用。

**文件**

- `infra/sandboxes/computer/Dockerfile`
- `infra/sandboxes/computer/start.sh`
- `.github/workflows/test-suites.yml` 或 `.github/workflows/computer-replay.yml`

**步骤**

1. Dockerfile 安装：
   - `at-spi2-core`
   - `python3-gi`
   - `gir1.2-atspi-2.0`
   - `gir1.2-gtk-3.0`
   - `gir1.2-gdkpixbuf-2.0`
2. 设置环境变量：
   - `GTK_MODULES=gail:atk-bridge`
   - `NO_AT_BRIDGE=0`
   - `QT_ACCESSIBILITY=1`
3. `start.sh` 在 DBus session 启动后：
   - 启动 `at-spi-bus-launcher` 或 `at-spi2-registryd`。
   - 启动 `python3 /usr/local/bin/atspi.py`。
   - 等待 `/tmp/rakazo/perception.sock`。
4. 退出时清理 socket。
5. 在 CI 增加 Python 测试步骤：
   - `python3 infra/sandboxes/computer/test_atspi.py`

**验证**

```bash
pnpm sandbox:build
docker run --rm -e RAKAZO_COMPUTER_CONTROL_TOKEN=test rakazo/computer:local \
  rakazo-perception <<< '{"cmd":"capabilities"}'
```

**完成标准**

- 健康检查能返回 AT-SPI 可用。
- 没有 AT-SPI 的环境返回 `unknown` 而不是崩溃。
- 旧镜像不受影响。

### P1-05 Linux adapter 接入感知

**目标**

让 `LinuxDesktop` 能调用 perception，并给 `SandboxProvider` 提供 `findElements`、`settle`、`zoom`。

**文件**

- `packages/adapters/src/computers/perception/atspi-perception.ts`
- `packages/adapters/src/computers/perception/perception.ts`
- `packages/adapters/src/computers/screens/linux-desktop.ts`
- `packages/adapters/src/computers/sandbox/remote-desktop-sandbox.ts`
- `packages/adapters/src/computers/sandbox/configured-sandbox.ts`
- `packages/adapters/src/computers/sandbox/host-aware-sandbox.ts`
- `packages/adapters/src/providers/computer/docker/docker-sandbox.ts`
- `packages/adapters/src/providers/computer/fake/fake-sandbox.ts`

**步骤**

1. `AtspiPerception` 调 `rakazo-perception`：
   - `host.run` 带 `DISPLAY=:N`。
   - stdin 写 JSON。
   - 解析 stdout。
   - 超时映射 `unknown`。
2. `LinuxDesktop` 增加：
   - `findElements`
   - `settle`
   - `zoom`
3. `observe` 增加可选 `pointer` 和 `windows`，保持 image 为主。
4. `LinuxDesktopSandbox` 转发新方法。
5. `ConfiguredSandbox`、`HostAwareSandbox`、`RemoteDesktopSandbox` 转发。
6. `DockerSandboxProvider` 实现新方法。
7. `FakeSandboxProvider` 用 `FakePerception` 实现，供测试。
8. 单测：
   - target 找不到返回 `stale`。
   - 超时返回 `unknown`。
   - 旧 provider 没有方法时返回明确错误。

**验证**

```bash
pnpm exec vitest run packages/adapters/src/computers/perception packages/adapters/src/computers/screens
pnpm check
```

**完成标准**

- 旧镜像不受影响。
- 没有 AT-SPI 时 `findElements` 返回 `unknown`，不抛未处理错误。
- `computer_observe` 的 image 行为不变。

### P1-06 target 解析与新鲜度

**目标**

让 `computer_act` 接受 `target` 和 `basedOn`，解析成坐标，并在目标变化时返回 `stale`。

**文件**

- `packages/adapters/src/computers/screens/computer-tools.ts`
- `packages/adapters/src/computers/screens/extra-displays.ts`
- `packages/adapters/src/computers/screens/linux-desktop.ts`
- `packages/adapters/src/computers/screens/computer-tools.test.ts`
- `packages/adapters/src/computers/screens/extra-displays.test.ts`

**步骤**

1. `parseComputerActions` 接受 `target` 和 `basedOn`。
2. `computerActionCount` 和 `boundedComputerActions` 处理新字段。
3. `extraDisplayActionCommand`：
   - `target` 存在时先解析到 `point`。
   - `source: "ax"` 用 `find`。
   - `source: "cdp"` 用 page browser。
   - `source: "coords"` 直接用 point。
4. 解析后 hit-test：
   - 元素不存在 -> `stale`。
   - 点不在 bbox 内 -> `stale`。
   - `basedOn` 与当前 frame 不同 -> `stale`。
5. 新增 `ComputerStaleError`，工具层转成可读错误。
6. 测试：
   - 正常点击。
   - 目标消失。
   - 目标移动。
   - 旧 frame。
   - 坐标 fallback。

**验证**

```bash
pnpm exec vitest run packages/adapters/src/computers/screens/computer-tools.test.ts \
  packages/adapters/src/computers/screens/extra-displays.test.ts
```

**完成标准**

- 坐标路径完全不变。
- target 路径不会误点。
- 错误信息告诉模型重新 observe。

### P1-07 工具定义与 handler

**目标**

向模型暴露 `computer_find`、`computer_zoom`、`computer_settle`，并扩展 `computer_act` 的 schema。

**文件**

- `packages/adapters/src/tools/builtin-computer.tool-definition.ts`
- `packages/adapters/src/runs/tools/run-tools-computer.ts`
- `packages/adapters/src/runs/tools/run-tool-selection.ts`
- `packages/adapters/src/tools/builtin-tool-bridge.ts`
- `packages/adapters/src/runtime/context/context-pruning.ts`
- `packages/adapters/src/runtime/pi/tools/pi-runtime-tools.ts`
- `packages/adapters/src/models/model-vision.ts`
- `packages/adapters/src/routines/release-watch.ts`

**步骤**

1. `computer_find`：
   - 输入 `text`、`role`、`app`、`window`、`page`、`limit`。
   - 返回 elements、url、truncated、unknown。
2. `computer_zoom`：
   - 输入 `frameId`、`region`。
   - 返回新的 observation。
3. `computer_settle`：
   - 输入 `quietMs`、`firstMs`、`timeoutMs`、`verb`。
   - 返回 changed、lastChangeMono、quiet、noVisibleChange。
4. `computer_act` schema 增加 `target`、`basedOn`。
5. handler 调 `SandboxProvider` 新方法。
6. 工具列表、vision gate、context pruning、release watch 同步新工具名。
7. 测试：
   - 工具定义快照。
   - handler 参数校验。
   - 旧 provider 错误。

**验证**

```bash
pnpm exec vitest run packages/adapters/src/runs/tools/run-tools-computer.test.ts \
  packages/adapters/src/tools/builtin-computer.tool-definition.test.ts
```

**完成标准**

- 工具名和 schema 稳定。
- 没有把 frame id、计数、用户数据放进 system prompt。
- 旧工具行为不变。

### P1-08 提示词

**目标**

让模型知道什么时候用 `computer_find` + target，什么时候用坐标。

**文件**

- `packages/adapters/src/runs/assembly/run-instructions.prompt.ts`
- `packages/adapters/src/computers/screens/computer-support.prompt.ts`
- `packages/adapters/src/runtime/pi/tools/pi-runtime-tools.ts`

**步骤**

1. 在图形电脑指令里增加：
   - 原生应用优先 `computer_find` + target。
   - 页面继续优先 `browser_snapshot`。
   - canvas、游戏、远程桌面用坐标。
   - 用户控制后重新 observe。
   - target 返回 stale 时不要重放旧动作。
2. 保持 cached prefix 稳定，不加入每次变化的 id、计数、时间。
3. 更新 prompt 快照测试。
4. 如果有 eval，在 PR 里说明是否运行。

**验证**

```bash
pnpm exec vitest run packages/adapters/src/runs/assembly/run-instructions.test.ts
```

**完成标准**

- 提示词简洁，不重复接口。
- 不把 tool 结果写进 system prompt。
- 没有 per-run 变化。

### P1-09 Web UI

**目标**

在电脑面板和全屏视图里增加 Find 和 Zoom 的渐进披露入口。

**文件**

- `apps/web/src/pages/shell/computers/computer-panel.tsx`
- `apps/web/src/pages/shell/computers/computer-overlay.tsx`
- `apps/web/src/pages/shell/computers/use-computer-controls.tsx`
- `apps/web/src/pages/shell/computers/*.test.tsx`

**步骤**

1. 全屏视图增加 Find 输入框：
   - 按名称搜索。
   - 结果列表最多 30 条。
   - 点击结果后调用 `computer_act` target。
2. 增加 Zoom：
   - 以当前 cursor 为中心，固定 640x400 区域。
   - 返回新 observation。
3. 保持默认界面简洁：
   - 不常驻解释文字。
   - 用图标按钮和可访问名称。
4. 测试：
   - 打开 Find。
   - 搜索结果。
   - 点击 target。
   - Zoom。
5. 截图。

**验证**

```bash
pnpm --filter @rakazo/web test
pnpm exec biome check --write apps/web/src/pages/shell/computers
```

**完成标准**

- 不抢焦点。
- 关闭后恢复原布局。
- 没有硬编码颜色或高度 class。

### P1-10 Mobile UI

Status: 已完成。`apps/mobile/app/computer.tsx` 只负责渲染，查找、缩放、点击的保存状态放在
`apps/mobile/lib/computers/use-computer-finder.ts`；Find 用原生 page sheet，Zoom 用全屏
`Modal`，两者都通过 `useSave` 报 pending 与失败，不手写 saving/error 状态。

**目标**

在 mobile 电脑视图里增加 Find 和 Zoom，复用 native controls。

**文件**

- `apps/mobile/app/computer.tsx`
- `apps/mobile/components/computers/computer-keyboard-bar.tsx`
- `apps/mobile/lib/computers/*`
- 对应测试

**步骤**

1. 增加 Find：
   - 原生 sheet 或菜单。
   - 结果列表。
   - 点击 target。
2. 增加 Zoom：
   - 以当前 cursor 为中心。
   - 保持 keyboard bar 可用。
3. 测试：
   - 打开 Find。
   - 选择结果。
   - Zoom 后布局。
4. 截图。

**验证**

```bash
pnpm exec vitest run apps/mobile
```

**完成标准**

- 使用 native controls。
- 不出现 raw id。
- 键盘和 tabletop 不回归。

### P1-11 Docker 集成

Status: 已完成。`packages/testkit/src/computers/computer-perception.docker.test.ts` 在真实镜像里
打开 `thunar`，用 `computer_find` 找到 `Open Parent` 并按 target 点击、验证窗口标题变成 `home`；
杀掉 helper 后 `find` 返回 `unknown` 而坐标点击仍然可用；两台电脑各自只看到自己 display 上的窗口。
`pnpm test:computer-replay` 同时跑 replay、user identity 和这三个用例，7 个全绿。

**目标**

在真实 Docker 电脑上验证语义感知和 target 操作。

**文件**

- `packages/testkit/src/computers/computer-replay.docker.test.ts`
- `packages/testkit/src/computers/computer-user.docker.test.ts`
- `packages/testkit/src/computers/computer-use.e2e.test.ts`
- `infra/sandboxes/computer/test_atspi.py`

**步骤**

1. 在 Docker 镜像里打开 `mousepad` 或 `thunar`。
2. 用 `computer_find` 找到按钮或输入框。
3. 用 target 点击。
4. 验证文字或文件变化。
5. 两个 display 并发：
   - bot A 只看 A 的窗口。
   - bot B 只看 B 的窗口。
6. 旧镜像：
   - 没有 AT-SPI 时返回 `unknown`。
   - 坐标路径仍可用。
7. 超时：
   - 挂起应用时 `find` 返回 `unknown`，输入不受阻塞。

**验证**

```bash
pnpm sandbox:build
pnpm test:computer-replay
python3 infra/sandboxes/computer/test_atspi.py
```

**完成标准**

- 真实 Docker 通过。
- 多 display 不串。
- 旧镜像 fallback 通过。

### P1-12 文档与 PR

**目标**

把行为变化写清楚，附上截图和测试结果。

**文件**

- `docs/computer-runtime.md`
- `docs/computer.md`
- `docs/computer-experience-architecture.md`
- `docs/computer-experience-plan.md`

**步骤**

1. 更新文档：
   - 新工具。
   - target 语义。
   - `unknown` 和 `stale`。
   - 多 display 行为。
   - 旧镜像 fallback。
2. PR 描述：
   - `## What`
   - `## Why`
   - `## Changes`，最多 8 条。
   - `## Tested`，说明跑了哪些测试，没跑什么。
3. 附截图：
   - Find。
   - Zoom。
   - 多 display。
4. 不提交 secrets、私有 URL、个人数据。

**完成标准**

- 文档和代码一致。
- PR 描述能让没看过代码的人理解。
- 截图能展示变化。

## 5. Phase 2：串流

### P2-01 ScreenStreamProvider

**文件**

- `packages/adapters/src/computers/stream/stream-provider.ts`
- `packages/adapters/src/computers/stream/vnc-stream.ts`
- `packages/adapters/src/computers/screens/linux-desktop.ts`
- `packages/adapters/src/providers/computer/docker/docker-sandbox.ts`

**步骤**

1. 定义 `ScreenStreamProvider`。
2. VNC 作为默认实现，行为不变。
3. `ScreenSession` 增加可选 `protocol` 和 `quality`。
4. 测试 view/control token、reconnect、close。

**验证**

```bash
pnpm exec vitest run packages/adapters/src/computers/stream
pnpm test:computer-replay
```

### P2-02 WebRTC 实现

**文件**

- `packages/adapters/src/providers/stream/<id>/`
- `infra/sandboxes/computer/`

**步骤**

1. 在 provider 目录实现 WebRTC 串流，不把 vendor 名称带进共享 contracts。
2. 保持 view/control token 和屏幕租约。
3. quality report 由 daemon 统一设置，一次 capture 服务多个 viewer。
4. 测试 60fps、延迟、断线重连、移动端键盘。

**验证**

```bash
pnpm test:computer-replay
pnpm --filter @rakazo/web test
```

## 6. Phase 3：桌面应用与 work context

### P3-01 computer-desktop 镜像

**文件**

- `infra/sandboxes/computer/Dockerfile`
- `infra/sandboxes/computer/start.sh`
- `packages/adapters/src/providers/computer/*`

**步骤**

1. 增加可选 `computer-desktop` tag。
2. 安装 LibreOffice、GIMP、VSCodium、Thunar、字体、输入法。
3. `launch_app` catalog。
4. `ComputerCapabilities.programs`。

### P3-02 work context

**文件**

- `packages/adapter-kit/src/types.ts`
- `packages/adapters/src/computers/perception/`
- `packages/adapters/src/tools/`
- `packages/adapters/src/runs/assembly/run-instructions.prompt.ts`

**步骤**

1. 只读 `computer_capabilities` 或 `work_context`。
2. 返回程序可用性、内存、display、perception、stream、recording、连接器和最近失败。
3. 模型根据 capabilities 选择 surface。

## 7. Phase 4：录制回放

### P4-01 Recorder

**文件**

- `packages/adapters/src/computers/recording/recorder.ts`
- `packages/adapters/src/computers/recording/manifest.ts`
- `packages/adapters/src/computers/recording/storage.ts`
- `packages/contracts/src/computers/computer.ts`

**步骤**

1. 每个 run 一个 recording 目录。
2. manifest 记录 state、codec、width/height、first/last、bytes、fragments、activity、gaps。
3. 用户控制、其他 bot 窗口、串流丢失、磁盘满、大小上限、recorder 失败都记 gap。
4. 存储上限和保留期。
5. 导出 MP4/WebM 在电脑侧完成。

### P4-02 回放 UI

**文件**

- `apps/web/src/pages/shell/computers/*`
- `apps/mobile/app/computer.tsx`

**步骤**

1. 时间线、速度、跳 idle。
2. Desktop/Browser 轨道。
3. 导出 sheet。
4. 隐私提示和 gap 标记。

## 8. 测试矩阵

| 层            | 测试                                         | 命令                                                                               |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| 类型          | `pnpm check`                                 | `pnpm check`                                                                       |
| Lint          | Biome                                        | `pnpm lint`                                                                        |
| 检查          | 仓库 checks                                  | `pnpm checks`                                                                      |
| 感知单测      | `packages/adapters/src/computers/perception` | `pnpm exec vitest run packages/adapters/src/computers/perception`                  |
| 屏幕单测      | `packages/adapters/src/computers/screens`    | `pnpm exec vitest run packages/adapters/src/computers/screens`                     |
| 工具单测      | `run-tools-computer.test.ts`                 | `pnpm exec vitest run packages/adapters/src/runs/tools/run-tools-computer.test.ts` |
| Python helper | `test_atspi.py`                              | `python3 infra/sandboxes/computer/test_atspi.py`                                   |
| 镜像          | `pnpm sandbox:build`                         | `pnpm sandbox:build`                                                               |
| Docker replay | `pnpm test:computer-replay`                  | `pnpm test:computer-replay`                                                        |
| Web           | `@rakazo/web`                                | `pnpm --filter @rakazo/web test`                                                   |
| Mobile        | `@rakazo/mobile`                             | `pnpm exec vitest run apps/mobile`                                                 |
| 真实 provider | computer E2E                                 | `pnpm test:computer --sandbox=e2b`                                                 |

## 9. 命令速查

```bash
# 格式化
pnpm exec biome check --write <files>

# 类型检查
pnpm check

# Lint
pnpm lint

# 仓库检查
pnpm checks

# 感知与屏幕单测
pnpm exec vitest run packages/adapters/src/computers/perception
pnpm exec vitest run packages/adapters/src/computers/screens

# 工具单测
pnpm exec vitest run packages/adapters/src/runs/tools/run-tools-computer.test.ts

# Python helper
python3 infra/sandboxes/computer/test_atspi.py

# 镜像
pnpm sandbox:build

# Docker 回放
pnpm test:computer-replay

# Web
pnpm --filter @rakazo/web test

# Mobile
pnpm exec vitest run apps/mobile
```

## 10. 风险与回滚

| 风险            | 触发条件                 | 回滚                                                           |
| --------------- | ------------------------ | -------------------------------------------------------------- |
| AT-SPI 挂起     | helper 不响应            | 超时返回 `unknown`，替换 helper；必要时关闭 `perception.atspi` |
| 多 display 串窗 | PID/window 过滤错误      | 先只服务主 display；坐标路径保持可用                           |
| Chromium 双算   | 页面和 chrome 都返回元素 | 页面走 CDP，chrome 走 AT-SPI；去重                             |
| 镜像变大        | 桌面应用层进默认镜像     | 使用单独 `computer-desktop` tag                                |
| 串流迁移失败    | WebRTC 不稳定            | VNC 保持默认，capability 关闭 WebRTC                           |
| 录制磁盘满      | 视频过大                 | 大小上限、保留期、gap、停止录制                                |
| 安全边界        | AT-SPI 暴露文本          | 只读 role/name/bounds/state，不读 value                        |

## 11. 安全与隐私检查

- AT-SPI 只读 role、name、bounds、state。
- 密码字段 mask。
- secret 字段不进入日志。
- 名称、深度、元素数有上限。
- 不把 raw id 展示到 UI。
- CDP 只绑定 loopback。
- 页面工具走 guard。
- 屏幕 view/control token 分离。
- 租约 fence，旧连接不能重定向。
- 每台电脑独立网络，egress 限制，uid 1000。
- `CapDrop: ALL`，`no-new-privileges`。
- 录制在用户控制时暂停。
- 导出前提示隐私范围。
- 不提交 secrets、`.env`、私有 URL、个人数据。

## 12. 观测

新增日志和指标：

- `computer.perception.timeout`
- `computer.perception.unknown`
- `computer.target.stale`
- `computer.settle.timeout`
- `computer.stream.reconnect`
- `computer.recording.gap`
- `computer.perception.duration_ms`
- `computer.perception.unknown_rate`
- `computer.target.stale_rate`
- `computer.stream.fps`
- `computer.recording.bytes`

日志不包含页面文本、元素 value、secret 或用户数据。

## 13. PR 拆分

| PR   | 内容                           | 可以合并的时机             |
| ---- | ------------------------------ | -------------------------- |
| PR 1 | P1-01 契约 + P1-02 fake        | 类型和单测通过，无行为变化 |
| PR 2 | P1-03 helper + P1-04 镜像      | 镜像构建和 Python 测试通过 |
| PR 3 | P1-05 adapter + P1-06 target   | 单测通过，旧镜像 fallback  |
| PR 4 | P1-07 工具 + P1-08 提示词      | 工具测试和 prompt 快照通过 |
| PR 5 | P1-09 Web + P1-10 Mobile       | UI 测试和截图通过          |
| PR 6 | P1-11 Docker 集成 + P1-12 文档 | 真实 Docker 通过           |

## 14. 开放决策

| 决策              | 默认                                    | 需要确认                      |
| ----------------- | --------------------------------------- | ----------------------------- |
| 多 display helper | 一个 helper 按 display 过滤             | 压测后决定是否每 display 一个 |
| settle            | Phase 1 用截图 diff，Phase 2 用 XDamage | 截图 diff 的性能是否可接受    |
| zoom              | 用 `librakazo-xcapture.so` 裁剪         | 是否需要新的 capture CLI      |
| 串流              | VNC 默认，WebRTC 第二                   | 是否接受 vendor adapter 目录  |
| 录制              | WebM 先，MP4 导出后                     | 浏览器兼容和编码成本          |
| 桌面应用          | 单独 `computer-desktop` tag             | 镜像大小和 plan 归属          |
| work context      | 新工具 `computer_capabilities`          | 是否复用 `work_context` 命名  |

## 15. 执行顺序

1. 先做 PR 1（契约 + fake），确保没有行为变化。
2. 再做 PR 2（helper + 镜像），确保镜像可构建、可健康检查。
3. 然后做 PR 3（adapter + target），确保旧镜像 fallback。
4. 接着做 PR 4（工具 + 提示词），让模型能用。
5. 再做 PR 5（Web + Mobile），让用户能看到。
6. 最后做 PR 6（Docker 集成 + 文档），收口。

Phase 1 完成后再开 Phase 2。不要在一个 PR 里同时改感知、串流和录制。

## 16. Phase 1 执行 checklist

### P1-01 契约

- [x] 新增 `ComputerRect`、`ComputerTarget`、`ComputerElement`、`ComputerWindow`。
- [x] 新增 `ComputerFindRequest/Result`、`ComputerSettleRequest/Result`、`ComputerZoomRequest`、`ComputerCapabilities`。
- [x] 扩展 `ComputerObservation` 的 `pointer`、`windows`、`elements`。
- [x] 扩展 `ComputerAction` 的 `target`、`basedOn`、`drag`、`zoom`、`settle`。
- [x] 扩展 `SandboxKindCapabilities`。
- [x] 扩展 `SandboxProvider` 可选方法。
- [x] 扩展 `ComputerStatusSchema`，保持向后兼容。

### P1-02 Fake perception

- [x] 定义 `ComputerPerception` interface。
- [x] 实现 `FakePerception`。
- [x] 覆盖精确匹配、前缀匹配、role 过滤、`unknown`、`truncated`。

### P1-03 AT-SPI helper

- [x] 新增 `atspi.py`。
- [x] 新增 `rakazo-perception` CLI。
- [x] 实现 `health`、`windows`、`tree`、`find`、`at`、`focused`、`capabilities`、`shutdown`。
- [x] 实现 display 过滤、deadline、元素上限、名称裁剪。
- [x] 新增 `test_atspi.py`。

### P1-04 镜像与启动

- [x] Dockerfile 安装 AT-SPI 依赖。
- [x] 设置 `GTK_MODULES`、`NO_AT_BRIDGE`、`QT_ACCESSIBILITY`。
- [x] `start.sh` 启动 AT-SPI bus 和 helper。
- [x] CI 增加 Python 测试步骤。
- [ ] 健康检查通过。

### P1-05 Linux adapter

- [x] 新增 `AtspiPerception`。
- [x] `LinuxDesktop` 增加 `findElements`、`settle`、`zoom`。
- [x] `observe` 增加 pointer。
- [x] 所有 provider/decorator 转发新方法。
- [x] 单测覆盖旧 provider fallback。

### P1-06 target 解析

- [x] `parseComputerActions` 接受 target/basedOn。
- [x] target 在工具层解析为坐标。
- [x] 新鲜度校验（find + bbox）。
- [x] `ComputerStaleError` 映射成可读错误。
- [x] 测试目标消失、移动、旧 frame、坐标 fallback。

### P1-07 工具

- [x] 新增 `computer_find`。
- [x] 新增 `computer_zoom`。
- [x] 新增 `computer_settle`。
- [x] 扩展 `computer_act` schema。
- [x] 更新工具列表、vision gate、context pruning、release watch。
- [x] 工具定义和解析测试。

### P1-08 提示词

- [x] 原生应用优先 `computer_find` + target。
- [x] 页面继续优先 `browser_snapshot`。
- [x] canvas/游戏/远程桌面用坐标。
- [x] stale 后重新 observe。
- [x] prompt 快照通过。

### P1-09 Web UI

- [x] Find 输入框和结果列表。
- [x] Zoom 按钮。
- [x] 可访问名称。
- [x] 测试。
- [ ] 截图。

### P1-10 Mobile UI

- [ ] 原生 Find sheet。
- [ ] 原生 Zoom 控件。
- [ ] 键盘条和 tabletop 不回归。
- [ ] 测试和截图。

### P1-11 Docker 集成

- [ ] 真实 `mousepad`/`thunar` 测试。
- [ ] target 点击测试。
- [ ] 多 display 隔离测试。
- [ ] 旧镜像 fallback 测试。
- [ ] 超时 `unknown` 测试。

### P1-12 文档与 PR

- [ ] 更新 `docs/computer-runtime.md`。
- [ ] 更新 `docs/computer.md`。
- [ ] PR 描述包含 `## What`、`## Why`、`## Changes`、`## Tested`。
- [ ] 附截图。
- [ ] 没有 secrets、私有 URL、个人数据。
