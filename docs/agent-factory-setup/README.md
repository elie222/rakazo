# Agent Factory 配置包（v0 · 零代码）

> 目标：在 Rakazo 上搭一条「需求进来 → Agent 团队自动干完 → 人只拍板」的交付流水线。
> 原则：流程是 SOP，不是状态机。所有机制均使用 Rakazo 现成原语，v0 不写一行内核代码。

## 架构一览

```text
新需求（Board 新票 或 群聊提出）
  │
  ▼
PO 例行扫板 ── 规格化 + 需求检查 ──► 【门禁 1：规格批准】
  │
  ▼
Coordinator 指派 Dev 开工 ─ 沙箱内开发 + 自测 ──► PR 提出
  │
  ▼
GitHub webhook routine ──► Reviewer 评审 ── CI 通过
  │
  ▼
QA 例行/事件触发 ── 验收报告 ──► 【门禁 2：上线批准】
  │
  ▼
Ops 部署 + 变更说明 ──► 票 done/closed，文档回写
  │
  └── Coordinator 停滞检测 ──► 票 blocked ──► 【门禁 3：异常决策】
```

## 角色与分工

| 角色 bot      | 职责                                                                         | 对应 Board 列 |
| ------------- | ---------------------------------------------------------------------------- | ------------- |
| `coordinator` | **流程调度员**：唯一流程所有者，扫板推进、停滞升级（不写码/不部署/不下结论） | 全部列        |
| `pm`          | 产品经理：backlog/优先级/路线图/需求仲裁（不写规格、不写码）                 | todo          |
| `po`          | 需求初审、规格化、检查清单、请求批准                                         | todo          |
| `dev`         | 沙箱开发、自测、提 PR                                                        | doing         |
| `reviewer`    | PR 评审、CI 检查、返工要求                                                   | review        |
| `qa`          | 测试验收、冒烟、验收报告                                                     | review → done |
| `ops`         | 部署、监控、变更说明、文档回写                                               | done → closed |

三个真门禁：规格批准、上线批准、异常决策。其余流转全部自动化。产品方向由人类拍板，`pm` 负责整理与执行。

## 使用的 Rakazo 原语

- **Board（Labs）**：需求对象 = 票；列 = 阶段；指派给 bot 即开工。单账户在 **Settings → Labs** 开启；自托管用 `TICKET_BOARD_ENABLED=true` 配在 API 和 worker。
- **群聊**：协作现场；`@mention` 唤醒指定员工；群内 bot 可互发消息交接。
- **Routines**：流转引擎（扫板、webhook、git event 触发）。
- **审批模式**：Auto（需配置审批模型）+ Block 名单，把敏感动作收口到人。
- **技能（AgentSkill，空间级共享）**：SOP 的正式载体，SKILL.md 格式。
- **沙箱电脑（Computer）**：Dev/Ops 的工作环境（Docker/云/本机）。
- **Page**：需求台账/交付看板的对外视图。

## 目录

- `bots/` — 5 个数字员工的 instructions 模板（含 SOP 与交接协议）
- `board.md` — Board 列映射、票模板、优先级规则
- `routines.md` — 触发器配置清单
- `skills.md` — 技能池目录与权限预设
- `templates/` — 验收报告、变更说明模板
- `verification.md` — 端到端跑通验证清单

## 二开边界（v0 之后才考虑）

- 技能按 bot 硬隔离（`AgentSkill` 目前是空间级共享）——遇到真实误用再动。
- Board 列名扩展（contracts 里 6 态写死）——业务阶段名需要时再动。
- 需求台账 Page、发布通知 bot——需求出现后再做。

## 分支约定

- 二开工作只在 `agent-factory/*` 分支上进行；`main` 仅用于同步上游。
