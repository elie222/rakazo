# Routines 触发器配置

流转引擎由 6 条 routine 组成。全部通过 bot 的 **Agent computer → Routines** 或群聊直接让 bot 创建。

## R0a：PM backlog 治理（schedule）

- **拥有者**：`pm`
- **触发**：`Add trigger → On a schedule`，`Advanced...` 填 cron：`0 */6 * * *`
- **指令**：

```text
扫描 Board 的 todo 列：按价值/风险/依赖为每张票标记优先级并写排序理由；价值不明确的票向人类确认是否要做（门禁 0）。不做实时调度，不写规格。
```

## R0：Coordinator 扫板（schedule · 流程所有者）

- **拥有者**：`coordinator`
- **触发**：`Add trigger → On a schedule`，`Advanced...` 填 cron：`*/5 * * * *`
- **指令**：

```text
扫描 Board 全部列，按推进表逐票决策（todo→指派 dev、doing/review/done 超时检测、blocked→升级人类）。每个决定：更新票（指派/移列/评论结论）+ 群聊 @责任人。你只调度，不写码、不部署、不下业务结论。推进表见你的 Instructions。
```

## R1：PO 扫板（schedule）

- **拥有者**：`po`
- **触发**：`Add trigger → On a schedule`，`Advanced...` 填 cron：`*/15 * * * *`
- **指令**：

```text
扫描本空间 Board 的 todo 列。按优先级取最旧一张未处理票：
1. 没有规格的票 → 产出规格与检查清单，作为评论贴到票上。
2. 规格不完整 → 回复提问澄清，保持 todo。
3. 规格完整 → 贴「规格批准」审批卡（修改动作会自动触发）；批准后把票指派给 dev，移到 doing。
没有可处理的票就结束，不输出。
```

## R2：Reviewer 评审（git event）

- **拥有者**：`reviewer`
- **触发**：`Add trigger → Git event`，把给出的 URL 配到 GitHub 仓库 webhook（`pull_request` 事件）
- **指令**：

```text
收到 PR 事件后：
1. 找到对应的票（PR 描述或分支名含票号/标题）。
2. 打开 PR 评审：检查 DoD、跑规定检查命令、审 diff。
3. 有问题 → 在 PR 评论列出 issue，要求 dev 返工（在群聊 @dev），票保持 review。
4. 通过且 CI 绿 → 在票上留结论，@qa 触发验收。
```

## R3：QA 验收（git event / webhook）

- **拥有者**：`qa`
- **触发**：CI 完成 webhook（`Add trigger → Webhook`，把 URL+key 给 CI 流程 POST）。只在 reviewer 通过且 CI 绿时发送；PR 打开或更新本身不是验收信号。
- **指令**：

```text
收到「评审通过/CI 完成」信号后：
1. 在沙箱按验收 SOP 运行测试与冒烟（见技能 acceptance-run）。
2. 出验收报告，贴到票上（模板见 templates/acceptance-report.md）。
3. 红灯 → 列明失败项，票保持 review，@dev 返工。
4. 绿灯 → 票移到 done，@ops 部署（贴「上线批准」审批卡，人批准后继续）。
```

## R4：Ops 部署（webhook / schedule）

- **拥有者**：`ops`
- **触发**：`Webhook`（CI/CD 发布完成的回调）或 `On a schedule`（`*/30 * * * *`）巡检 `done` 列
- **指令**：

```text
对每张处于 done 的票：
1. 确认上线批准卡已通过。
2. 按部署 SOP 执行发布（沙箱/CI 回调）。
3. 验证健康检查，把部署日志链接贴到票上。
4. 按变更说明模板产出说明文档（技能 change-doc），票移到 closed。
```

## 触发矩阵

| 事件                  | 触发类型           | 唤醒员工                    |
| --------------------- | ------------------ | --------------------------- |
| 每 5 分钟             | schedule cron      | `coordinator`（调度所有票） |
| 每 6 小时             | schedule cron      | `pm`（backlog 治理）        |
| 每 15 分钟            | schedule cron      | `po`                        |
| PR opened/updated     | git event          | `reviewer`                  |
| CI 完成               | webhook            | `qa`                        |
| 每 30 分钟 / 发布回调 | schedule / webhook | `ops`                       |

> 调试 tip：routine 每次运行都会在对应 bot 的聊天里留记录；运行失败可从中查原因。
