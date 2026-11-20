# 技能池与权限预设

Rakazo 技能（AgentSkill）是**空间级共享**的：同一空间所有 bot 可见。因此「谁用什么技能」由各自的 instructions 约束；敏感执行能力由审批与工具禁用兜底。

## 技能池目录

| 技能名             | 所属     | 内容要点                                        |
| ------------------ | -------- | ----------------------------------------------- |
| `requirement-spec` | po       | 规格 checklist：目标/范围/不做什么/DoD/约束     |
| `pr-review`        | reviewer | 评审 checklist：正确性/安全/测试/规范，证据要求 |
| `acceptance-run`   | qa       | 验收 SOP：测试套件、冒烟、DoD 逐项、报告输出    |
| `deploy-sop`       | ops      | 部署 SOP：前置检查、发布步骤、健康检查、回滚    |
| `change-doc`       | ops      | 变更说明模板与回写流程                          |

每个技能按 SKILL.md 格式维护：`name`、`description`（给 bot 判断何时用）、正文（分步指令）。

## 权限预设（bot 设置 → Advanced）

**按 bot 禁用内置工具**（`Disable a tool`）：

| bot        | 建议禁用的工具                 |
| ---------- | ------------------------------ |
| `po`       | 所有写代码/部署类工具          |
| `dev`      | 部署、外发消息、支付类         |
| `reviewer` | 部署、支付、外发消息           |
| `qa`       | 部署、支付、外发消息           |
| `ops`      | 无（唯一被授权执行部署的 bot） |

**审批规则**（Settings → Approvals）：

- 模式：`Auto`（需配置审批模型）；拿不准的写动作会弹卡。
- Block 名单：在非 `ops` 的 bot 上把「生产部署/生产凭证/资金」类动作设为 Block，拒绝时不留卡。
- 上线批准与规格批准保持弹卡（`Auto` 不自动放行这两类）。

## 技能可见性：当前为软约束

技能空间级共享、由 instructions 限定使用，是 v0 的取舍。若出现真实误用（如 `dev` 读了 `deploy-sop` 并试图部署），二开方案是给 `AgentSkill` 加 bot 可见性映射（仿照 `AgentSkillSpace`），再提交到 `agent-factory/*` 分支。
