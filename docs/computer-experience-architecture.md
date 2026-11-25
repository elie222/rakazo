# Rakazo 电脑体验架构设计

Status: Design reference

Scope: Linux 电脑运行时、感知、输入、串流、桌面应用、录制回放。

Reference: 本文对照阅读了 localDot 的电脑实现，只作为参考实现，不引入为依赖。

Execution plan: [computer-experience-plan.md](./computer-experience-plan.md)

## 1. 结论

Rakazo 的电脑平台层已经比较完整：provider 抽象、执行/控制/屏幕租约、生命周期、快照、恢复、多租户隔离都在。缺的是电脑本身的体验层：

- 感知只有截图和坐标，没有可访问性树和元素定位。
- 输入是 xdotool 直接发命令，没有 press/release 回执、拖拽校验和 settle。
- 串流是 x11vnc/noVNC，不是低延迟的 WebRTC。
- 桌面只有 Xvfb + fluxbox + xterm + Chromium，没有办公和开发应用。
- 没有会话录制、回放和视频导出。
- 没有只读的 work context，模型无法先判断该用浏览器、桌面还是 shell。

建议的目标架构是：**保留 Rakazo 的 `SandboxProvider` 和租约模型，新增 `ComputerPerception`、`ComputerInput`、`ScreenStreamProvider`、`ComputerRecorder` 四个 port，把 localDot 的感知和输入设计移植到 Rakazo 的 provider 模型里。**

## 2. 目标与非目标

### 2.1 目标

- Linux 电脑可以用 role/name/app/window 定位元素，不再只靠截图和坐标。
- 点击、输入、滚动、拖拽前可以做 hit-test 和新鲜度校验，避免点错。
- 动作后可以等应用处理完，而不是固定 sleep。
- 可以按区域放大屏幕，读取小字和细节。
- 串流从 VNC 平滑迁移到 WebRTC，VNC 保留 fallback。
- 电脑有可选的桌面应用层，能打开文档、图片和代码仓库。
- 可以录制、回放和导出会话视频。
- 所有能力通过 `SandboxKindCapabilities` 声明，共享代码不分支 provider id。
- 旧镜像、旧 provider 和没有 AT-SPI 的环境可以安全降级。

### 2.2 非目标

- 不替换 Rakazo 现有的 `SandboxProvider`、`ConfiguredSandbox`、`HostAwareSandbox`。
- 不替换 page-browser、agent-browser 和 CDP 浏览器栈。
- 不把 localDot 的单 display、单用户、Docker-only 假设带进 Rakazo。
- 不在共享 contracts、设置、数据库列、路由或 UI 里写 vendor 名称。
- 不在运行时安装系统包，镜像内容全部在构建期确定。

## 3. 代码审计

### 3.1 Rakazo 现状

**Provider 抽象**

- `packages/adapter-kit/src/interfaces.ts` 的 `SandboxProvider` 已经定义 provision、execute、observe、act、files、workspace、snapshot、stop、destroy 等能力。
- `packages/adapter-kit/src/types.ts` 的 `SandboxKindCapabilities` 已经声明 terminal、inPlaceUpdate、nativeShell、runsOnUserMachine、screen、serverHomeMount、maxFileBytes 等能力。
- `packages/adapters/src/computers/computer-providers.ts` 注册了 16 个 provider。
- `ConfiguredSandbox` 和 `HostAwareSandbox` 是装饰器，新方法需要在这里转发。

**Linux 桌面**

- `packages/adapters/src/computers/screens/linux-desktop.ts` 的 `LinuxDesktop` 负责 display 分配、browser profile、observe、act、screen、terminal、release。
- `packages/adapters/src/computers/screens/extra-displays.ts` 把 action 翻译成 xdotool 命令。
- 观察走 `scrot` 或 `import`，并读取 `xdotool getmouselocation`。
- 动作走 `xdotool mousemove`、`click`、`key`、`type`、`mousedown`、`mouseup`。
- `settleMs` 目前是 `sleep`。

**Docker 与 supervisor**

- `packages/adapters/src/providers/computer/docker/docker-sandbox.ts` 的 `DockerSandboxProvider` 通过 supervisor HTTP 调用 `/computers`、`/observe`、`/actions`、`/screen`、`/input`。
- `infra/sandboxes/supervisor/src/routes.ts` 负责 provision、observe、actions、screen、files 等路由。
- `infra/sandboxes/supervisor/src/screens.ts` 负责每个 bot 的 display slot、view token、eviction 和 teardown。
- `infra/sandboxes/computer/control.py` 是 token 保护的桌面控制服务，只服务交互式控制。
- `infra/sandboxes/computer/start.sh` 启动 Xvfb、DBus、portal、fluxbox、x11vnc、noVNC。
- `infra/sandboxes/computer/Dockerfile` 是 Debian bookworm + Xvfb + fluxbox + xterm + Chromium，没有 AT-SPI 和办公软件。

**工具与提示词**

- `packages/adapters/src/tools/builtin-computer.tool-definition.ts` 定义 `computer_observe`、`computer_act`、`browser_*`、`shell`、file tools、`open_path`、`launch_app`。
- `packages/adapters/src/runs/tools/run-tools-computer.ts` 的 `computerTools` 是工具处理器。
- `packages/adapters/src/computers/screens/computer-tools.ts` 负责 action 解析、视觉循环保护和 observation 结果。
- `packages/adapters/src/runs/assembly/run-instructions.prompt.ts` 已经有电脑使用说明，但仍然是坐标和截图的语义。

**Web 与 mobile**

- `apps/web/src/pages/shell/computers/computer-panel.tsx` 和 `computer-overlay.tsx` 已经有预览、Open、Take control、Stop、Save screenshot、teaching、recovery、disk warning。
- `apps/mobile/app/computer.tsx` 已经有 WebView、键盘条、tabletop、takeover、background pause。
- 没有 Find、Zoom、Record、Replay 的入口。

**结论**

Rakazo 的强项是平台和生命周期，不是电脑体验。现有实现可以继续承载多 bot、多租户和 provider-neutral，但感知、输入、串流、桌面应用和录制都需要补。

### 3.2 localDot 现状

**desktopd HTTP API**

- `cells/desktop/desktopd/src/app.ts` 暴露 observe、input、type、find、elements、hitTest、focused、zoom、settle、release、launch、window-control、browser/navigate、browser/read、shell、files、downloads 等路由。
- `packages/protocol/src/desktopd.ts` 定义 `WindowInfo`、`InputRequest`、`TypeRequest`、`SettleRequest`、`LaunchRequest`、`ObserveResult`、`ZoomRequest`、`HitTestRequest`、`FindRequest`、`ElementsRequest` 等 wire contract。

**感知**

- `cells/desktop/desktopd/src/perception/hit-test.ts` 把 CDP、AT-SPI 和坐标组合起来：
  - Chromium 页面内容优先 CDP。
  - 浏览器自己的 chrome 和原生应用走 AT-SPI。
  - 两者都失败时退回坐标，并返回 `unknown`。
- `cells/desktop/desktopd/src/perception/native.ts` 是持久 AT-SPI 客户端：
  - 独立 helper，避免挂起的应用阻塞输入。
  - 每次调用有 deadline。
  - 超时返回 `unknown`，不返回部分结果。
  - tree 按 window 和 generation 缓存。
- `cells/desktop/desktopd/x/native.py` 是 AT-SPI helper：
  - focus walk、tree walk、hit-test、focused element。
  - 处理 GTK 和 Chromium 的坐标单位。
  - 处理 LibreOffice VCL 的偏移。
  - 限制 scan、depth、tree 和 name 长度。

**输入**

- `cells/desktop/desktopd/src/input.ts` 用 raw XI2 press/release 做确认：
  - `withPress` 和 `withRelease` 订阅 raw event。
  - `NoPressError` 表示没按到。
  - activation 走 transient root，避免点菜单时把菜单关掉。
  - drag/drop 校验 drop point 的窗口没有变化。
  - motion samples 做平滑移动。

**settle**

- `cells/desktop/desktopd/src/settle.ts` 把 settle 请求转给 X helper。
- `cells/desktop/desktopd/x/xhelper.py` 用 DAMAGE、窗口变化和 `_NET_WM_PING` 判断应用是否处理完。
- 区分 ambient damage、periodic damage 和真正的变化。

**浏览器**

- `cells/browser/browserd/src/control.ts` 是浏览器控制租约，支持多任务 grants、user control、revision 和 stale 拒绝。
- `cells/browser/browserd/src/targets.ts` 管理多 tab、iframe、page、file chooser、下载和崩溃恢复。
- `cells/browser/browserd/src/observation.ts` 组合 capture、geometry、native、secrets 和 CDP。
- `cells/browser/browserd/src/cdp-guard.ts` 限制 CDP 方法，避免页面工具越权。

**录制**

- `packages/protocol/src/recording.ts` 定义 manifest、fragments、activity、gaps、recording state 和 session card。
- 录制按 desktop 和 browser 两条轨道，支持用户控制、其他任务、串流丢失、磁盘满、大小上限、recorder 失败等 gap。
- 导出 MP4/WebM 在电脑侧完成。

**工作上下文**

- `packages/protocol/src/work-context.ts` 定义只读的 `DesktopCapabilities`、`DesktopMemory`、`ToolRecovery` 和恢复建议。
- `work_context` 返回程序可用性、内存压力、浏览器 surface、连接器操作和最近失败。

**镜像**

- `cells/desktop/Dockerfile` 基于 linuxserver/webtop，带 XFCE、Selkies、LibreOffice、GIMP、VSCodium、Thunar、字体和 CUA driver。

**结论**

localDot 的电脑体验更完整，但它的假设是单 display、单用户、本地 Docker。Rakazo 不能直接复制这些假设，应该复制它的分层和契约。

### 3.3 差异总结

| 维度     | Rakazo                         | localDot                              | 设计取向    |
| -------- | ------------------------------ | ------------------------------------- | ----------- |
| 电脑抽象 | provider-neutral，多 provider  | 单 Docker cell                        | 保留 Rakazo |
| 观察     | 截图 + cursor + activeWindow   | 截图 + pointer + windows + elements   | 补 Rakazo   |
| 定位     | 坐标                           | role/name/app/window/url + bbox       | 补 Rakazo   |
| 输入     | xdotool                        | raw press/release + activation + drag | 补 Rakazo   |
| settle   | sleep                          | DAMAGE + `_NET_WM_PING`               | 补 Rakazo   |
| 串流     | VNC/noVNC                      | WebRTC                                | 抽象后迁移  |
| 桌面应用 | 轻量 sandbox                   | 完整 XFCE + 办公软件                  | 可选镜像层  |
| 录制     | 教学录制                       | 会话录制 + 回放 + 导出                | 补 Rakazo   |
| 生命周期 | 租约、快照、恢复、云/本地      | 本地 home、启动恢复                   | 保留 Rakazo |
| 多 bot   | 每 bot display、profile、lease | 单桌面多任务                          | 保留 Rakazo |

## 4. 目标架构

### 4.1 分层

```text
Tool layer
  computer_observe / computer_find / computer_act / computer_zoom / computer_settle
  browser_* / shell / files / open_path / launch_app / work_context
        |
ComputerPerception (port)
  LinuxAtspiPerception  -> 持久 AT-SPI helper
  CdpPerception         -> Chromium CDP
  CuaPerception         -> host macOS/Windows
  WuyingPerception      -> Windows 云电脑
  FakePerception        -> 测试
        |
ComputerInput (port)
  target -> point
  raw press/release
  activation
  drag/drop
  settle
        |
ScreenStreamProvider (port)
  VNC first
  WebRTC second
  quality reports
        |
ComputerRecorder (port)
  frames + event log
  gaps + manifest
  MP4/WebM export
        |
SandboxProvider (orchestration)
  Docker / E2B / Daytona / Boat / Boxd / Instabox / Railway / Kubernetes / Incus
  leases, lifecycle, snapshots, home storage
```

### 4.2 数据流

**查找元素**

```text
model
  -> computer_find(text="Save", role="button")
    -> SandboxProvider.findElements
      -> LinuxDesktop.find
        -> ComputerPerception.find
          -> AT-SPI helper / CDP
        -> elements + frameId + truncated + unknown
```

**按目标操作**

```text
model
  -> computer_act(target={ role, name, app, window, basedOn: frameId })
    -> parseComputerActions
    -> SandboxProvider.act
      -> LinuxDesktop.act
        -> resolve target
        -> hit-test
        -> xdotool / raw input
        -> settle
        -> observe
```

### 4.3 能力声明

共享代码只读 `SandboxKindCapabilities`，不读 provider id。

```ts
export interface SandboxKindCapabilities {
  // ...existing
  perception?: {
    atspi: boolean;
    cdp: boolean;
    hitTest: boolean;
    settle: boolean;
    zoom: boolean;
  };
  stream?: {
    protocol: "vnc" | "webrtc";
    quality: boolean;
  };
  recording?: boolean;
  desktopApps?: boolean;
}
```

## 5. 核心契约

### 5.1 目标与元素

```ts
export interface ComputerTarget {
  point: { x: number; y: number };
  bbox?: { x: number; y: number; w: number; h: number };
  source: "coords" | "ax" | "cdp";
  app?: string;
  window?: string;
  role?: string;
  name?: string;
  url?: string;
  secret?: boolean;
  editable?: boolean;
}

export interface ComputerElement extends ComputerTarget {
  ref?: string;
  state?: {
    value?: string;
    checked?: "true" | "false" | "mixed";
    disabled?: boolean;
    expanded?: boolean;
  };
}

export interface ComputerWindow {
  id: number;
  pid: number;
  cls: string;
  title: string;
  frame: Rect;
  active: boolean;
  overrideRedirect?: boolean;
  transientFor?: number | null;
}
```

### 5.2 查找、命中、缩放、settle

```ts
export interface ComputerFindRequest {
  text?: string;
  role?: string;
  app?: string;
  window?: string;
  page?: boolean;
  limit?: number;
}

export interface ComputerFindResult {
  elements: ComputerElement[];
  url?: string;
  truncated: boolean;
  unknown?: boolean;
}

export interface ComputerSettleRequest {
  quietMs?: number;
  firstMs?: number;
  timeoutMs?: number;
  verb?: "click" | "scroll" | "key" | "type" | "launch";
}

export interface ComputerSettleResult {
  changed: Rect[];
  lastChangeMono: number | null;
  quiet: boolean;
  noVisibleChange: boolean;
}

export interface ComputerZoomRequest {
  frameId: string;
  region: Rect;
}
```

### 5.3 Action 扩展

保留 x/y 作为 fallback，新增 `target` 和 `basedOn`。

```ts
export type ComputerAction =
  | (ComputerInput & { basedOn?: string })
  | {
      kind: "scroll";
      direction: "up" | "down" | "left" | "right";
      amount?: number;
      x?: number;
      y?: number;
      target?: ComputerTarget;
      basedOn?: string;
    }
  | { kind: "wait"; ms: number }
  | { kind: "open"; path: string }
  | { kind: "launch"; application: string; uri?: string }
  | { kind: "focus"; application: string; uri?: string }
  | {
      kind: "drag";
      from: ComputerTarget;
      to: ComputerTarget;
      durationMs?: number;
      basedOn?: string;
    }
  | { kind: "zoom"; region: Rect }
  | { kind: "settle"; request: ComputerSettleRequest };
```

### 5.4 SandboxProvider 扩展

新增方法全部可选，旧 provider 不需要实现。装饰器必须转发。

```ts
export interface SandboxProvider {
  // ...existing
  findElements?(
    computer: ComputerRef,
    request: ComputerFindRequest,
    context: AdapterContext,
  ): Promise<ComputerFindResult>;
  settle?(
    computer: ComputerRef,
    request: ComputerSettleRequest,
    context: AdapterContext,
  ): Promise<ComputerSettleResult>;
  zoom?(
    computer: ComputerRef,
    request: ComputerZoomRequest,
    context: AdapterContext,
  ): Promise<ComputerObservation>;
  capabilities?(computer: ComputerRef, context: AdapterContext): Promise<ComputerCapabilities>;
}
```

### 5.5 串流

```ts
export interface ScreenStreamProvider {
  readonly protocol: "vnc" | "webrtc";
  open(
    computer: ComputerRef,
    display: number,
    token: string,
    context: AdapterContext,
  ): Promise<ScreenSession>;
  close(computer: ComputerRef, display: number, context: AdapterContext): Promise<void>;
  reportQuality?(
    computer: ComputerRef,
    report: StreamQualityReport,
    context: AdapterContext,
  ): Promise<void>;
}
```

### 5.6 录制

```ts
export interface ComputerRecorder {
  start(computer: ComputerRef, runId: string, context: AdapterContext): Promise<void>;
  frame(computer: ComputerRef, frame: ComputerObservation, context: AdapterContext): Promise<void>;
  gap(computer: ComputerRef, reason: RecordingGapReason, context: AdapterContext): Promise<void>;
  stop(computer: ComputerRef, context: AdapterContext): Promise<RecordingRef>;
}
```

### 5.7 能力探测

```ts
export interface ComputerCapabilities {
  version: 1;
  search: "service_path";
  programs: Record<string, "available" | "not_on_path" | "unknown">;
  memory?: DesktopMemory;
  display: { width: number; height: number; scale: number };
  perception: {
    atspi: boolean;
    cdp: boolean;
    hitTest: boolean;
    settle: boolean;
    zoom: boolean;
  };
  stream: { protocol: "vnc" | "webrtc"; quality: boolean };
  recording: boolean;
  desktopApps: string[];
}
```

## 6. 关键设计决策

### 6.1 感知组合：CDP + AT-SPI + 坐标

不要三选一。localDot 的 `hit-test.ts` 已经证明组合可行：

- Web 内容优先 CDP。
- 浏览器 chrome、GTK/Qt 原生应用走 AT-SPI。
- 两者都失败时退回坐标，并返回 `unknown`。

这样既能覆盖 Web，也能覆盖原生应用，还不会假装“没有元素”。

落地时有两个环境前提，缺一个应用就永远不会出现在树里：

1. **启动顺序**：应用要在可访问性总线已经存在时启动。GTK 在启动那一刻连不上总线，会给这个进程
   关掉可访问性，之后不再重试。因此镜像启动和屏幕就绪都要等到 `at-spi` 的 bus socket 出现。
2. **执行环境**：Docker 的 exec 会替换镜像的 ENV。给 bot 跑命令时要把可访问性变量
   （`GTK_MODULES`、`NO_AT_BRIDGE`、`QT_ACCESSIBILITY`、`DBUS_SESSION_BUS_ADDRESS`）和
   `XDG_CACHE_HOME` 一起带上，否则 bot 自己启动的窗口没有树。

libatspi 会缓存已读过的无障碍对象，所以一个被 `SIGSTOP` 的应用可能仍然返回一份旧的树，而不是
超时。真正需要保证的是“请求在 deadline 内返回且不阻塞输入”，这一点由 helper 的 150ms 单次调用
超时和 5s 请求超时保证；`unknown` 出现在读不到（D-Bus 超时、helper 缺失）时。

### 6.2 多 display 是 Rakazo 特有的难点

localDot 是单 display，Rakazo 的 Team Computer 可能同时有 100+ 个 display。AT-SPI 的 `get_desktop(0)` 是 session-wide 的，不能直接按 display 过滤。

设计：

1. helper 接收 `--display :N`。
2. 在该 display 上跑 `wmctrl -lxp`，拿到窗口 id、PID、class、title、frame。
3. 遍历 AT-SPI app，只保留 PID 命中的 app。
4. 元素的 extents 映射到 device pixels，再按窗口 frame 裁剪。
5. 缓存 key 包含 `screenGeneration` 和 window id。
6. 超时返回 `unknown`，不返回部分结果。

如果多 display 过滤做不干净，先只让语义感知服务主 display，不要为了边缘场景把 helper 做复杂。

### 6.3 目标新鲜度

每次 action 都带 `basedOn: frameId`。执行前：

1. 目标存在。
2. 目标仍然在当前 frame 的窗口里。
3. hit-test 点到的元素仍然是目标。
4. 否则返回 `stale`，让模型重新 observe。

这可以避免“页面变了，模型还在点旧元素”。

### 6.4 输入确认

Phase 1 先用 xdotool，但动作后调用 settle。Phase 2 引入 raw press/release 回执：

- `NoPressError` 表示没按到。
- activation 走 transient root。
- drag/drop 校验 drop point 的窗口。
- 支持 hold、repeat、motion samples。

### 6.5 settle

不要固定 sleep。设计：

- `computer_settle` 返回 `changed`、`lastChangeMono`、`quiet`、`noVisibleChange`。
- 有 XDamage 时用 DAMAGE + `_NET_WM_PING`。
- 没有 XDamage 的 provider 退回 sleep。
- `computer_act` 的 `settle_ms` 保留兼容，内部优先走 settle。

### 6.6 串流

不要一次性删掉 VNC。先加 `ScreenStreamProvider`：

- VNC 是默认实现。
- WebRTC 是第二个实现。
- 保留 view/control token、屏幕租约、`screenGeneration`。
- 一次 capture 服务多个 viewer，daemon 统一设置 quality。
- 移动端键盘、剪贴板、断线重连继续由现有 UI 层负责。

### 6.7 录制

- 每个 run 一个 `recording/` 目录。
- manifest 记录 state、codec、width/height、first/last micros、bytes、fragments、activity、gaps。
- 用户控制、其他 bot 的窗口、串流丢失、磁盘满、大小上限、recorder 失败都记成 gap。
- 导出 MP4/WebM 在电脑侧完成。
- 存储上限和保留期由 `ComputerDisk` 统一管理。

### 6.8 桌面应用

- 单独做 `computer-desktop` 镜像 tag，或在多阶段构建里加一个 `desktop` 层。
- 加 LibreOffice、GIMP、VSCodium、Thunar、字体、输入法和文件选择器。
- `launch_app` 从任意字符串改成 catalog，`ComputerCapabilities.programs` 返回可用应用。
- 不要把办公软件塞进每个 sandbox 的默认镜像。

### 6.9 work context

增加只读的 `work_context` 或 `computer_capabilities`：

- 桌面可达性、常用 CLI 程序、内存压力。
- 浏览器是否可用、当前 surface。
- 连接器暴露的操作。
- 最近失败和恢复建议。

模型先看 capabilities，再决定用浏览器、桌面、shell 还是连接器。

### 6.10 安全

- AT-SPI 只读 role/name/bounds/state，不读 value。
- 密码字段 mask，secret 字段不进入日志。
- 名称、深度、元素数都有上限。
- 不把 raw id 展示到 UI。
- CDP 只绑定 loopback，页面工具走 guard。
- 屏幕 view/control token 分离，租约 fence，旧连接不能重定向。
- 每台电脑独立网络，egress 限制，uid 1000，`CapDrop: ALL`，`no-new-privileges`。
- 录制在用户控制时暂停，导出前提示隐私范围。

## 7. 代码落点

| 文件                                                                | 改动                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/adapter-kit/src/types.ts`                                 | 新增 `ComputerTarget`、`ComputerElement`、`ComputerWindow`、`ComputerFindRequest/Result`、`ComputerSettleRequest/Result`、`ComputerCapabilities`；扩展 `ComputerAction`、`ComputerObservation` |
| `packages/adapter-kit/src/interfaces.ts`                            | `SandboxProvider` 增加可选 `findElements`、`settle`、`zoom`、`capabilities`                                                                                                                    |
| `packages/adapters/src/computers/perception/`                       | 新增 `perception.ts`、`atspi-perception.ts`、`cdp-perception.ts`、`x11-perception.ts`、`target.ts`、`fake-perception.ts`                                                                       |
| `packages/adapters/src/computers/screens/linux-desktop.ts`          | 组合 perception/input/settle；`observe`/`act` 接入 target                                                                                                                                      |
| `packages/adapters/src/computers/screens/computer-tools.ts`         | 解析 `target`、`basedOn`、`drag`、`zoom`、`settle`；保持 visual loop guard                                                                                                                     |
| `packages/adapters/src/runs/tools/run-tools-computer.ts`            | 新增 `computer_find`、`computer_zoom`、`computer_settle` handler                                                                                                                               |
| `packages/adapters/src/tools/builtin-computer.tool-definition.ts`   | 新工具 schema 和描述                                                                                                                                                                           |
| `packages/adapters/src/runs/assembly/run-instructions.prompt.ts`    | 原生应用优先 `computer_find` + target；canvas/游戏用坐标；`basedOn` 新鲜度                                                                                                                     |
| `infra/sandboxes/computer/atspi.py`                                 | 新增持久 AT-SPI helper                                                                                                                                                                         |
| `infra/sandboxes/computer/control.py`                               | 增加 `/v1/perception` 或独立 Unix socket 代理                                                                                                                                                  |
| `infra/sandboxes/computer/start.sh`                                 | 启动 AT-SPI bus 和 helper                                                                                                                                                                      |
| `infra/sandboxes/computer/Dockerfile`                               | 加 `at-spi2-core`、`python3-gi`、`gir1.2-atspi-2.0`、`gir1.2-gtk-3.0`；设置 `GTK_MODULES=gail:atk-bridge`、`NO_AT_BRIDGE=0`、`QT_ACCESSIBILITY=1`                                              |
| `infra/sandboxes/supervisor/src/routes.ts`                          | 代理 perception 请求，保持 token/lease                                                                                                                                                         |
| `packages/adapters/src/providers/computer/docker/docker-sandbox.ts` | 实现新方法                                                                                                                                                                                     |
| `packages/adapters/src/computers/sandbox/remote-desktop-sandbox.ts` | E2B/Daytona/Boat 共用实现                                                                                                                                                                      |
| `packages/adapters/src/computers/screens/extra-displays.ts`         | target -> 坐标；drag/drop；settle                                                                                                                                                              |
| `packages/contracts/src/computers/computer.ts`                      | `ComputerStatus` 增加 perception/stream/recording 能力                                                                                                                                         |
| `apps/web/src/pages/shell/computers/*`                              | 增加 Find、Zoom、Record、Replay 的渐进披露                                                                                                                                                     |
| `apps/mobile/app/computer.tsx`                                      | 同上，保留 keyboard bar 和 tabletop                                                                                                                                                            |
| `packages/adapters/src/computers/stream/`                           | 新增 `ScreenStreamProvider`、VNC/WebRTC 实现                                                                                                                                                   |
| `packages/adapters/src/computers/recording/`                        | 新增 `ComputerRecorder`、manifest、导出                                                                                                                                                        |

## 8. 分阶段实施

### Phase 1：语义感知

范围：

- AT-SPI helper + `/perception` 代理。
- `computer_find`、`computer_zoom`、`computer_settle`。
- `ComputerAction` 的 `target`、`basedOn`。
- 能力 flag + 旧镜像 fallback。

验收：

- Docker 上能按名称找到 Files 的地址栏并点击。
- 多 display 只看到自己的窗口。
- AT-SPI 超时返回 `unknown` 而不是空。
- 旧镜像自动退回坐标。
- 没有 prompt 回归。

### Phase 2：串流

范围：

- `ScreenStreamProvider` 抽象。
- VNC 保持默认，WebRTC 作为第二个实现。
- quality report 和 viewer 调优。

验收：

- 60fps、延迟、断线重连、移动端键盘/剪贴板。
- VNC 仍可回退。

### Phase 3：桌面应用 + work context

范围：

- `computer-desktop` 镜像层。
- `launch_app` catalog、`ComputerCapabilities.programs`。
- `work_context` 只读探测。

验收：

- 打开 xlsx/docx/pptx、编辑图片、打开代码仓库。
- 模型能根据 capabilities 选择 surface。

### Phase 4：录制回放

范围：

- `ComputerRecorder` + manifest + gaps。
- Web/mobile 时间线、速度、跳 idle、导出 MP4/WebM。

验收：

- 录制、回放、导出、存储上限、隐私缺口。

## 9. 测试策略

- **契约测试**：`ComputerPerception` 用 fake 实现，覆盖 `unknown`、`truncated`、多 display、stale。
- **Docker 集成**：真实镜像 + `thunar`/`mousepad` + Chromium；测 `find`、`hitTest`、`act`、`settle`、`zoom`；两个 display 并发。
- **Provider conformance**：现有 `SandboxProvider` suite 增加可选方法；Docker/E2B/Daytona/Boat 都要过。
- **Prompt 测试**：`run-instructions` 快照；不把 frame id、计数、用户数据放进 system prompt；`basedOn` 只在 tool args。
- **UI 测试**：web/mobile 截图；Find/Zoom/Record 的渐进披露；不抢焦点。
- **性能**：tree walk 用 `expectLinearTime`；元素数、深度、名称长度都有上限；不用手写 sleep。
- **安全**：AT-SPI 不读 value；密码 mask；日志 redact；token 不下发客户端；CDP guard。

## 10. 风险与备选

| 风险                  | 影响               | 缓解                                                |
| --------------------- | ------------------ | --------------------------------------------------- |
| AT-SPI 挂起           | 感知阻塞           | 独立 helper、per-call deadline、超时替换、`unknown` |
| 多 display 过滤不干净 | 跨 bot 看到元素    | 先只服务主 display，再扩展；按 PID/window 过滤      |
| Chromium 可访问性     | 页面和 chrome 双算 | 页面走 CDP，chrome 走 AT-SPI                        |
| 镜像变大              | 启动和存储成本     | 桌面应用单独 tag，不进默认 sandbox                  |
| WebRTC 迁移           | 串流回退风险       | VNC 保留 fallback，分阶段切换                       |
| 录制存储              | 磁盘和隐私         | 大小上限、保留期、gap、导出提示                     |
| 安全边界              | AT-SPI 暴露文本    | 只读 role/name/bounds/state，不读 value             |

备选方案：

- 只做 CUA driver，不做 AT-SPI。问题是 Linux 原生应用覆盖不足。
- 只做 OCR，不做可访问性树。问题是不稳定，且读不到 role/name。
- 只做 VNC，不迁移 WebRTC。问题是移动端和实时性不足。
- 只做轻量 sandbox，不做桌面应用。问题是人工接管体验差。

## 11. 验收标准

- `computer_find` 能在 Docker 电脑上找到原生应用的按钮、输入框和菜单项。
- `computer_act` 能按 target 点击，点错时返回 `stale`，不会误点。
- 多 display 并发时，每个 bot 只看到自己的窗口。
- 旧镜像没有 AT-SPI 时，自动退回坐标，不报错。
- 动作后 settle 能等到应用处理完，减少重复点击。
- 串流在 VNC 和 WebRTC 之间可切换，view/control token 不泄漏。
- 录制能回放，用户控制区间有 gap，导出不包含 secret 值。
- `pnpm checks` 通过，新增测试覆盖行为，不重复现有测试。

## 12. 开放问题

- 远程 provider 的镜像是否都带 `at-spi2-core` 和 PyGObject？需要逐个确认。
- Chromium 是否需要额外启动参数才能暴露 accessibility tree？需要真实镜像验证。
- 多 display 是每个 display 一个 helper，还是一个 helper 按 display 分片？需要压测后决定。
- WebRTC 采用哪条实现路径？需要评估现有 VNC 网关的替换成本。
- 录制采用 MP4 还是 WebM 作为默认？需要评估浏览器兼容和编码成本。
- 桌面应用层是否按 plan 提供？需要和计费、镜像大小一起决定。
