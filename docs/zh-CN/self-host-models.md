# 模型接入

[English](../self-host-models.md) | 简体中文

连接自己的模型或本地服务器，并配置默认模型、审批和语音。下列环境设置应同时提供给 API 和 worker。

## 在应用中连接模型

网页、桌面和移动端均可在“设置 → 模型”中连接模型。
接入 Ollama、LM Studio、llama.cpp、MLX 等兼容服务器时，选择“OpenAI 兼容”，
填写服务器基础 URL（例如 `http://127.0.0.1:8000/v1`）、准确的模型 ID，以及服务器需要的 API 密钥。

在“高级”中可添加请求头；其值会加密保存，保存后只显示名称。
如果模型支持图片，在“高级”中启用“支持图片”，否则图片附件和基于截图的计算机工具不可用；
已有连接默认不启用。集中管理的兼容端点还可设置
`RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS=gpt4o-vision,llava` 作为部署级回退。

地址必须能从 **API 和 worker 所在环境**访问。容器里的 `127.0.0.1` 指向容器自身，不能用它表示宿主机。
Docker Desktop 可使用 `host.docker.internal`；其他部署宜使用稳定的局域网私有 IP。
Linux 默认不提供相同的 `host.docker.internal` 行为。

只连接自己掌控的端点：提示词、附件和工具结果会发往该地址。
公开地址携带 API 密钥或自定义请求头时需要 HTTPS，并且解析结果必须全部是公网地址。
`RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=0` 可禁止普通公开兼容端点。
私有端点默认受限。部署运营方可在 API 和 worker 上同时设置 `MCP_ALLOW_PRIVATE_ENDPOINT=true`，
并重建相应服务，允许用户连接私有模型端点。此权限对部署内所有用户生效，不只对管理员生效；
仅在接受这项访问范围时启用，元数据和链路本地目标仍会被阻止。
自定义主机名解析到私有 IP 时，还需在 API 和 worker 的部署环境中设置
`RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS=models.example.test,other.example.test`，然后重建这些容器。
条目必须是精确主机名（大小写不敏感，可带末尾点），不能使用 URL、后缀或通配符。
这些主机忽略 `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC`；DNS 的每个答案都必须是私有地址，
元数据和链路本地目标仍会被阻止。此设置适用于模型发现和实际请求。
HTTPS 仍会校验证书；和私有 IP 端点一样，受信任主机名也允许携带 API 密钥时使用 HTTP，
但除非网络可信，否则应使用 HTTPS，并且只允许自己控制的主机。

在 Docker Desktop 上，机器人计算机也可能通过 `host.docker.internal` 访问宿主机仅绑定回环地址的服务。
机器人运行期间，不要在该地址上开放未经认证的敏感服务，或通过防火墙阻断这条访问路径。

## 部署默认模型

未连接个人模型的用户使用部署默认模型。`PI_DEFAULT_PROVIDER` 选择提供商，`PI_DEFAULT_MODEL` 选择模型。

| `PI_DEFAULT_PROVIDER` | 密钥                 | 默认模型                     |
| --------------------- | -------------------- | ---------------------------- |
| `openrouter`（默认）  | `OPENROUTER_API_KEY` | `anthropic/claude-haiku-5.5` |
| `anthropic`           | `ANTHROPIC_API_KEY`  | `claude-sonnet-5`            |
| `deepseek`            | `DEEPSEEK_API_KEY`   | `deepseek-flash`             |

需要截图计算机工具时，选择支持视觉的模型。
Compose 也会将运行时支持的标准提供商密钥（例如 `OPENAI_API_KEY`、`GEMINI_API_KEY`）传给 API 和 worker，
用于没有已存储凭据的模型。`RAKAZO_LIVE_MODEL_CATALOG=off` 可关闭在线模型目录探测。
其他标准密钥还包括 `MISTRAL_API_KEY`、`GROQ_API_KEY` 和 `XAI_API_KEY`。

使用宿主机凭据的云模型需显式设置 `PI_DEFAULT_CREDENTIALS=host`。
例如 Bedrock 使用 `PI_DEFAULT_PROVIDER=amazon-bedrock`、`PI_DEFAULT_MODEL`、`AWS_REGION` 和宿主机角色；
Vertex 使用 `PI_DEFAULT_PROVIDER=google-vertex` 及宿主机的应用默认凭据
（`GOOGLE_APPLICATION_CREDENTIALS`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`）。
使用宿主机凭据的请求费用由对应云账号承担。
使用实例角色时，应保留[计算机出站限制（英文）](../self-host-docker-computers.md#restricted-computer-egress)，
防止机器人通过元数据端点读取角色凭据。

## 集中配置本地模型

也可以为整个部署列出本地模型：

```env
RAKAZO_LOCAL_MODELS=qwen3:4b,llama3.1:8b,qwen3-vl
RAKAZO_LOCAL_MODELS_URL=http://127.0.0.1:11434/v1
# 可选：服务器需要密钥时，作为 Bearer token 发送
RAKAZO_LOCAL_MODELS_API_KEY=
RAKAZO_LOCAL_CONTEXT_WINDOW=32768
RAKAZO_LOCAL_MAX_TOKENS=4096
# 此端点中支持图片的模型 ID
RAKAZO_LOCAL_VISION_MODELS=qwen3-vl
# 此端点中支持标准 reasoning_effort 的模型 ID
RAKAZO_LOCAL_REASONING_MODELS=qwen3:4b
```

这个回环地址示例适用于在宿主机运行源码服务；容器部署应改为容器可达的地址。
服务器需要密钥时设置 `RAKAZO_LOCAL_MODELS_API_KEY`，例如 LiteLLM、使用 `--api-key` 启动的 vLLM
或公司网关；发送到 `RAKAZO_LOCAL_MODELS_URL` 的每个请求都会带上 `Authorization: Bearer`。
未设置时请求使用占位值 `local`。该密钥和其余部署密钥一样只保留在 API 和 worker 上，并会从运行输出中隐藏。
除非网络可信，否则应使用 HTTPS。若要把本地模型设为部署默认模型，还需设置
`PI_DEFAULT_PROVIDER=local`、`PI_DEFAULT_MODEL` 为 `RAKAZO_LOCAL_MODELS` 中的某个模型，并设置
`PI_DEFAULT_CREDENTIALS=host`。
`RAKAZO_LOCAL_MAX_TOKENS` 是每次请求的输出上限，连接自身设置优先，且不会超过上下文窗口的四分之一。
输出上限越大，留给提示词的空间越少，长聊天可能更早压缩。将 `RAKAZO_LOCAL_MODELS` 留空可禁用此提供商。

Ollama Cloud 可直接在“设置 → 模型”中填写其 API 密钥并查找模型，无需配置环境变量；
即使 `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=0`，该入口仍可用。

## 思考能力与缓存

服务器支持标准 `reasoning_effort` 时，可在连接的“高级”选项中启用思考能力，无需重启。
已有连接默认不启用。部署本地列表中的模型可通过 `RAKAZO_LOCAL_REASONING_MODELS` 声明支持标准思考参数的模型 ID，无需重新连接。
启用后默认使用中等思考强度；网页和桌面可在机器人的高级设置中调整，移动端遵循相同后端策略。
服务器负责将 `minimal`、`low`、`medium`、`high` 或关闭时的 `none` 转为模型所需形式。
这不会增加独立的思考 token 预算，原有输出限制仍然适用。

连接 API 还支持 `cacheCapabilities`。只有服务器确实支持前缀保留时，才声明正的 `retentionMs`。
缓存是否仍然有效仅是提示，修改指令或工具、上下文压力、进程重启等都可能使缓存失效；
这些设置不会创建 KV 快照或让模型持续驻留。完整字段见[提示词缓存能力（英文）](../self-host-models.md#prompt-cache-capabilities)。

## 审批

“设置 → 审批”有三种模式：“从不询问”跳过常规审批提示；“自动”由审批模型判断操作是否符合请求；“询问”在任何更改前请求确认。
所有模式仍遵守阻止规则和安全检查。购买始终需要人工确认，无法请求确认的无人值守运行会拒绝购买。
新空间默认使用自动模式，但没有可用审批模型时，会像询问模式一样请求确认。
每个人还可以允许或阻止特定工具和站点；空间也可使用独立设置。

在“设置 → 模型 → 审批模型”中，可以从已有连接选择模型，并按顺序添加备用模型，与主模型分别配置。
只有检查器失败时才尝试备用模型；明确要求确认或无法确定的判断仍须由用户处理。
个人连接使用自己的凭据；托管调用采用与聊天相同的额度规则。

未选择个人审批模型时，使用部署默认检查器。部署默认检查器的配置、超时和置信度设置见[审批配置（英文）](../self-host-models.md#approvals)。
核心功能不要求启用托管检查服务。

使用 OpenRouter Jev 时，设置 `RAKAZO_AUTO_REVIEW_PROVIDER=openrouter` 和
`RAKAZO_AUTO_REVIEW_MODEL=typesafe/jev-1.14`；它使用 `OPENROUTER_API_KEY` 和 Decisions API。
直接使用 TypeSafe 时设置 `RAKAZO_AUTO_REVIEW_PROVIDER=jev` 和 `TYPESAFE_API_KEY`。
核心功能不依赖这两个托管服务。使用 TypeSafe 时，`RAKAZO_AUTO_REVIEW_MODEL` 默认是
`jev-latest`，`RAKAZO_AUTO_REVIEW_MIN_CONFIDENCE`（0 到 1，默认 `0.5`）是低于此置信度时询问用户的阈值，
`RAKAZO_AUTO_REVIEW_TIMEOUT_MS`（200 到 30000，默认 `10000`）限制每次检查。

## 图片与视频生成

默认关闭。需要启用时，在 worker（内联执行时还包括 API）配置媒体提供商及其通用 HTTP 连接。
密钥保留在服务器，不能提交到仓库：

```dotenv
MEDIA_GENERATION_PROVIDER=fal
MEDIA_GENERATION_BASE_URL=https://queue.fal.run
MEDIA_GENERATION_API_KEY=replace-with-media-api-key
MEDIA_GENERATION_IMAGE_MODEL=fal-ai/flux/schnell
MEDIA_GENERATION_VIDEO_MODEL=fal-ai/wan/v2.2-a14b/text-to-video
```

`MEDIA_GENERATION_PROVIDER` 接受 `disabled`（默认）、`fal` 或 `fake`（仅用于离线测试）。
`MEDIA_GENERATION_BASE_URL` 可选，默认使用上面的地址。只为要启用的能力设置图片或视频模型字段。
兼容服务器可以复用同一组连接字段，但模型必须支持相应的队列 API 以及 Flux/Wan 的输入和输出格式。
请把这些值放进部署的密钥配置，不要提交真实凭据。

图片工具生成 PNG；视频工具提交四秒 MP4，并返回任务 ID 和排队或运行状态。
worker 会在后台持续检查任务，重启后也会继续，并将完成的视频发送到原聊天一次，再让机器人跟进。
视频失败或一小时后仍未完成时，会标记为失败并让机器人说明。机器人也可通过 `jobId` 查询进度。
两种工具默认都需要审批，且每次运行最多提交两次（失败也计入），工单运行不可使用这些聊天媒体工具。
提交不会自动重试，因为提供商可能已经接受并计费；应在提供商处配置预算和限流。
输出还必须同时满足 10 MiB 媒体上限和部署附件上限。

## 付费数据服务

机器人可以通过一个部署账户查询付费数据（地图地点、搜索结果、工作邮箱、人物和公司资料、
社交帖子、SEO 数据）。此功能默认关闭。在 worker（内联执行时还包括 API）中配置：

```dotenv
PAID_SERVICES_PROVIDER=treg
PAID_SERVICES_API_KEY=replace-with-org-scoped-token
```

`PAID_SERVICES_PROVIDER` 接受 `disabled`（默认）、`treg` 或 `fake`（仅用于离线测试）。
`PAID_SERVICES_BASE_URL` 可把请求指向自托管的 Treg，而不是 `https://treg.to`。
请使用组织级令牌，并保持账户余额充足或开启自动充值；余额为空时每次调用都会失败。

机器人每次运行都会获得 `service_search` 和 `service_call`；`service_call` 和其他操作一样
遵循机器人的审批模式。只提供只读查询：账户操作、生成任务以及需要账户自身连接的服务不会开放。
每次调用有机器人设置、审批卡展示的费用上限（最多 $2），提供商在收费前会强制执行。
启用模型额度时，调用会先从组织额度中预留该上限，再按提供商实际收费加 20% 结算，且不会超过上限；
提供商未收费的调用免费。可能已运行但没有返回结果的调用会保留预留，交由额度核对器标记。
每次调用都会出现在用量中的 `services` 提供商下。

## 语音与通话

API 在 macOS 上运行时，可使用系统自带的 macOS 声音，无需密钥；Docker 和 Linux 主机不提供此选项。
音频由 API 生成后在收听设备播放。

朗读摘要默认关闭。设置 `VOICE_SUMMARY_MIN_CHARS`（例如 `600`）后，较长回复会由机器人的模型额外生成朗读摘要。
这会增加一次模型调用，按机器人模型计费；聊天保留完整回复，摘要失败时朗读原文。

Fish Audio 连接未指定模型时，`FISH_TTS_MODEL` 默认是 `s2.1-pro`，`FISH_ASR_MODEL` 默认是 `transcribe-1-pro`。

API 和 worker 设置 `PHONE_CALLS_ENABLED=true` 后，可启用机器人来电和按住说话。
`PHONE_CALL_COOLDOWN_MINUTES` 默认是 `2`，`PHONE_CALL_RING_SECONDS` 默认是 `45`。
移动端原生来电与可选推送配置见[移动端来电（英文）](../self-host-clients.md#mobile-incoming-calls)。
