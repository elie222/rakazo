# 登录门与计算机屏幕

[English](../self-host-kubernetes.md#add-a-login-gate-without-breaking-the-computer) | 简体中文

在域名前增加基于 Cookie 的登录门（例如 Google + oauth2-proxy）时，普通页面带着外层登录 Cookie，可以通过检查。机器人的计算机画面在独立浏览器框架中加载，其请求**可能不携带外层 Cookie**；若把这些请求也发给 Google 登录，就会出现本应显示画面或 WebSocket 的地址被重定向到登录页，等待更久也无法恢复。

Rakazo 在用户通过应用会话打开计算机后，会签发短时、加密的 URL，其中包含针对特定屏幕的**持有者能力（bearer capability）**：在过期或被作废前，持有该 URL 即可通过 web 代理与 API 的校验（含当前计算机/会话代次、生命周期与控制租约）。

**做法概要：**

- 在外层只对常规页面和 API 做 Cookie 登录；**仅将** `/novnc/session/*` 直接转发到 Rakazo 的 web 代理，由 Rakazo 校验自己的能力 URL。
- API 与 web 中的 `SCREEN_PROXY_SECRET` 必须一致，且不同于应用认证密钥；不要放宽 iframe 沙箱或 `X-Frame-Options`。
- 不要把例外扩大到 `/novnc/*`、`/api/*` 或整个主机名；例外只绕过**外层 Cookie 检查**，不绕过 Rakazo 自身的屏幕授权。
- 各层代理、访问日志、分析和截图中都不要记录完整屏幕 URL；能力 URL 泄露后应停止计算机以作废能力，仅退出 Google 不会撤销已签发的 URL。

Caddy 边缘示例见 [`docs/examples/kubernetes/Caddyfile.edge.example`](../examples/kubernetes/Caddyfile.edge.example)。生产 Compose 单机在[生产部署（英文）](../self-host-production.md)中说明同源与转发；Kubernetes 完整步骤见 [Kubernetes 安装（英文）](../self-host-kubernetes.md#add-a-login-gate-without-breaking-the-computer)。

移动应用经同一入口访问时，原生客户端对 `/rpc/health` 期望 JSON 而非重定向；可在 Caddy 上为 `/api/*`、`/rpc/*` 配置独立的 `X-Access-Key` 路由（与 Google 门并存），在应用 **Server → Headers** 中配置。本地计算机客户端无法发送该密钥，此门仅适用于本指南配置的 Kubernetes 计算机等场景。详情见英文 Kubernetes 文档中的「Connect the mobile app through the same gate」一节。
